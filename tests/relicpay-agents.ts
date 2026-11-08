// RelicPay Agents: the full demo story as tests, plus every rejection.
// Happy path, then each rule the program enforces, then "the agent tries to
// revoke or raise its own limits" and fails.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { PublicKey, Keypair, LAMPORTS_PER_SOL, SystemProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, getAccount } from "@solana/spl-token";
import { assert } from "chai";

const USDC = (n: number) => new BN(Math.round(n * 1_000_000));

describe("relicpay agents", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.RelicpayAgents as Program<any>;
  const pid = program.programId;

  const owner = Keypair.generate();
  const agent = Keypair.generate();
  const ibgShop = Keypair.generate();
  const attacker = Keypair.generate(); // the wallet a prompt injection tries to pay

  const pda = (...seeds: (Buffer | Uint8Array)[]) =>
    PublicKey.findProgramAddressSync(seeds, pid)[0];
  const pool = pda(Buffer.from("pool"));
  const mint = pda(Buffer.from("mock_usdc"));
  const liquidity = pda(Buffer.from("liquidity"));
  const collateral = pda(Buffer.from("collateral"));
  const vault = pda(Buffer.from("vault"), owner.publicKey.toBuffer());
  const mandate = pda(Buffer.from("mandate"), owner.publicKey.toBuffer(), agent.publicKey.toBuffer());
  const agreementAt = (i: number) => {
    const idx = Buffer.alloc(4);
    idx.writeUInt32LE(i);
    return pda(Buffer.from("agreement"), mandate.toBuffer(), idx);
  };
  const ata = (who: PublicKey) => getAssociatedTokenAddressSync(mint, who);
  const programData = PublicKey.findProgramAddressSync(
    [pid.toBuffer()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
  )[0];

  async function expectError(fn: () => Promise<unknown>, code: string) {
    try {
      await fn();
    } catch (err: any) {
      const text = `${err?.error?.errorCode?.code ?? ""} ${(err?.logs ?? []).join(" ")} ${err}`;
      assert.include(text, code);
      return;
    }
    assert.fail(`expected ${code}`);
  }

  const purchase = async (amount: BN, merchant: PublicKey, signer = agent, reason = "test") => {
    const m: any = await program.account.mandate.fetch(mandate);
    return program.methods
      .agentPurchase(amount, reason)
      .accountsPartial({
        agent: signer.publicKey,
        mandate,
        vault,
        pool,
        mint,
        liquidity,
        merchant,
        merchantUsdc: ata(merchant),
        agreement: agreementAt(m.purchases),
      })
      .signers([signer])
      .rpc();
  };

  const params = (o: Partial<Record<string, any>> = {}) => ({
    budget: USDC(60),
    perPurchaseCap: USDC(40),
    expiresAt: new BN(Math.floor(Date.now() / 1000) + 3600),
    allowedMerchants: [ibgShop.publicKey],
    ...o,
  });

  before(async () => {
    const latest = await provider.connection.getLatestBlockhash();
    const sigs = await Promise.all(
      [owner, agent, attacker].map((k) =>
        provider.connection.requestAirdrop(k.publicKey, 2 * LAMPORTS_PER_SOL)
      )
    );
    await Promise.all(
      sigs.map((s) => provider.connection.confirmTransaction({ signature: s, ...latest }, "confirmed"))
    );
  });

  it("rejects init_pool from anyone but the deployer", async () => {
    await expectError(
      () =>
        program.methods
          .initPool()
          .accountsPartial({ authority: attacker.publicKey, programData, pool, mint, liquidity, collateral })
          .signers([attacker])
          .rpc(),
      "NotUpgradeAuthority"
    );
  });

  it("deployer creates the pool with mock USDC liquidity", async () => {
    await program.methods
      .initPool()
      .accountsPartial({ authority: provider.wallet.publicKey, programData, pool, mint, liquidity, collateral })
      .rpc();
    const liq = await getAccount(provider.connection, liquidity);
    assert.equal(liq.amount.toString(), USDC(1_000_000).toString());
  });

  it("owner gets mock USDC and deposits 125, unlocking a 100 credit line", async () => {
    await program.methods
      .faucet(USDC(500))
      .accountsPartial({ user: owner.publicKey, pool, mint, userUsdc: ata(owner.publicKey) })
      .signers([owner])
      .rpc();
    await program.methods
      .depositCollateral(USDC(125))
      .accountsPartial({ owner: owner.publicKey, vault, pool, ownerUsdc: ata(owner.publicKey), collateral })
      .signers([owner])
      .rpc();
    const v: any = await program.account.creditVault.fetch(vault);
    assert.equal(v.collateral.toString(), USDC(125).toString());
  });

  it("rejects a mandate with invalid limits", async () => {
    await expectError(
      () =>
        program.methods
          .createMandate(params({ budget: USDC(10) })) // budget below the cap
          .accountsPartial({ owner: owner.publicKey, vault, agent: agent.publicKey, mandate })
          .signers([owner])
          .rpc(),
      "InvalidMandate"
    );
  });

  it("owner writes the mandate: 60 budget, 40 per purchase, IBG Shop only", async () => {
    await program.methods
      .createMandate(params())
      .accountsPartial({ owner: owner.publicKey, vault, agent: agent.publicKey, mandate })
      .signers([owner])
      .rpc();
    const m: any = await program.account.mandate.fetch(mandate);
    assert.ok(m.agent.equals(agent.publicKey));
    assert.equal(m.budget.toString(), USDC(60).toString());
  });

  it("agent buys a 40 USDC item: merchant paid instantly, debt recorded", async () => {
    await purchase(USDC(40), ibgShop.publicKey, agent, "IBG print");
    const shop = await getAccount(provider.connection, ata(ibgShop.publicKey));
    assert.equal(shop.amount.toString(), USDC(40).toString());
    const a: any = await program.account.agreement.fetch(agreementAt(0));
    assert.equal(a.amountOwed.toString(), USDC(40).toString());
    assert.equal(a.reason, "IBG print");
    const v: any = await program.account.creditVault.fetch(vault);
    assert.equal(v.debt.toString(), USDC(40).toString());
  });

  it("BLOCKED: 50 at IBG Shop is over the per-purchase cap", async () => {
    await expectError(() => purchase(USDC(50), ibgShop.publicKey), "OverPurchaseCap");
  });

  it("BLOCKED: prompt-injected payment to an unknown wallet", async () => {
    await expectError(() => purchase(USDC(10), attacker.publicKey), "MerchantNotAllowed");
  });

  it("BLOCKED: 30 more would go over the 60 budget", async () => {
    await expectError(() => purchase(USDC(30), ibgShop.publicKey), "OverBudget");
  });

  it("BLOCKED: a key that is not the mandate's agent", async () => {
    await expectError(() => purchase(USDC(5), ibgShop.publicKey, attacker), "NotMandateAgent");
  });

  it("BLOCKED: agent tries to raise its own limits", async () => {
    await expectError(
      () =>
        program.methods
          .updateMandate(params({ budget: USDC(10_000), perPurchaseCap: USDC(10_000) }))
          .accountsPartial({ owner: agent.publicKey, mandate })
          .signers([agent])
          .rpc(),
      "NotMandateOwner"
    );
  });

  it("BLOCKED: agent tries to revoke the mandate itself", async () => {
    await expectError(
      () =>
        program.methods
          .revokeMandate()
          .accountsPartial({ owner: agent.publicKey, mandate })
          .signers([agent])
          .rpc(),
      "NotMandateOwner"
    );
  });

  it("BLOCKED: agent cannot touch the owner's collateral", async () => {
    await expectError(
      () =>
        program.methods
          .withdrawCollateral(USDC(1))
          .accountsPartial({ owner: agent.publicKey, vault, pool, ownerUsdc: ata(owner.publicKey), collateral })
          .signers([agent])
          .rpc(),
      "ConstraintSeeds"
    );
  });

  it("BLOCKED: owner cannot withdraw collateral that backs their debt", async () => {
    // 40 debt needs 50 collateral at 80% LTV, so 76 of 125 is too much.
    await expectError(
      () =>
        program.methods
          .withdrawCollateral(USDC(76))
          .accountsPartial({ owner: owner.publicKey, vault, pool, ownerUsdc: ata(owner.publicKey), collateral })
          .signers([owner])
          .rpc(),
      "ExceedsCreditLine"
    );
  });

  it("BLOCKED: purchase that would pass the 80% credit line", async () => {
    // Owner raises the mandate (legitimately) to 200; the credit line still caps at 100.
    await program.methods
      .updateMandate(params({ budget: USDC(200), perPurchaseCap: USDC(70) }))
      .accountsPartial({ owner: owner.publicKey, mandate })
      .signers([owner])
      .rpc();
    await expectError(() => purchase(USDC(70), ibgShop.publicKey), "ExceedsCreditLine");
    await program.methods
      .updateMandate(params())
      .accountsPartial({ owner: owner.publicKey, mandate })
      .signers([owner])
      .rpc();
  });

  it("owner taps Revoke; the agent is BLOCKED: MandateRevoked", async () => {
    await program.methods
      .revokeMandate()
      .accountsPartial({ owner: owner.publicKey, mandate })
      .signers([owner])
      .rpc();
    await expectError(() => purchase(USDC(10), ibgShop.publicKey), "MandateRevoked");
  });

  it("BLOCKED: an expired mandate", async () => {
    const agent2 = Keypair.generate();
    const sig = await provider.connection.requestAirdrop(agent2.publicKey, LAMPORTS_PER_SOL);
    await provider.connection.confirmTransaction(sig, "confirmed");
    const mandate2 = pda(Buffer.from("mandate"), owner.publicKey.toBuffer(), agent2.publicKey.toBuffer());
    const now = Math.floor(Date.now() / 1000);
    await program.methods
      .createMandate(params({ expiresAt: new BN(now + 2) }))
      .accountsPartial({ owner: owner.publicKey, vault, agent: agent2.publicKey, mandate: mandate2 })
      .signers([owner])
      .rpc();
    await new Promise((r) => setTimeout(r, 4000));
    const idx = Buffer.alloc(4);
    await expectError(
      () =>
        program.methods
          .agentPurchase(USDC(5), "late")
          .accountsPartial({
            agent: agent2.publicKey,
            mandate: mandate2,
            vault,
            pool,
            mint,
            liquidity,
            merchant: ibgShop.publicKey,
            merchantUsdc: ata(ibgShop.publicKey),
            agreement: pda(Buffer.from("agreement"), mandate2.toBuffer(), idx),
          })
          .signers([agent2])
          .rpc(),
      "MandateExpired"
    );
  });

  it("owner repays; debt clears and the trust record goes up", async () => {
    const repay = (amount: BN) =>
      program.methods
        .repay(amount)
        .accountsPartial({
          owner: owner.publicKey,
          vault,
          agreement: agreementAt(0),
          pool,
          ownerUsdc: ata(owner.publicKey),
          liquidity,
        })
        .signers([owner])
        .rpc();
    await expectError(() => repay(USDC(41)), "OverRepay");
    await repay(USDC(15));
    await repay(USDC(25));
    const v: any = await program.account.creditVault.fetch(vault);
    assert.equal(v.debt.toString(), "0");
    assert.equal(v.loansRepaid, 1);
    const a: any = await program.account.agreement.fetch(agreementAt(0));
    assert.equal(a.status, 1);
    await expectError(() => repay(USDC(1)), "AlreadyRepaid");
  });
});
