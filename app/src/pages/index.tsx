import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import BN from "bn.js";
import { Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { useAnchorWallet, useConnection } from "@solana/wallet-adapter-react";
import { AgentConsole, loadDemoAgent } from "../components/AgentConsole";
import {
  COLLATERAL,
  LIQUIDITY,
  MERCHANTS,
  MINT,
  POOL,
  USDC,
  ata,
  explainError,
  explorerTx,
  mandateOf,
  merchantLabel,
  programFor,
  toUsdc,
  vaultOf,
} from "../lib/relic";

// The wallet button reads browser-only state; render it client-side.
const WalletMultiButton = dynamic(
  async () => (await import("@solana/wallet-adapter-react-ui")).WalletMultiButton,
  { ssr: false }
);

type Notice = { kind: "ok" | "err"; text: string; sig?: string } | null;

function Motif() {
  return (
    <svg width="54" height="18" viewBox="0 0 54 18" aria-hidden="true">
      <polygon points="9,1 17,17 1,17" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="27" cy="9" r="8" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <rect x="38" y="1" width="15" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export default function Home() {
  const { connection } = useConnection();
  const wallet = useAnchorWallet();
  const program = useMemo(() => (wallet ? programFor(connection, wallet) : null), [connection, wallet]);

  const [vault, setVault] = useState<any>(null);
  const [mandates, setMandates] = useState<any[]>([]);
  const [agreements, setAgreements] = useState<any[]>([]);
  const [usdcBalance, setUsdcBalance] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);

  const [deposit, setDeposit] = useState("125");
  const [agentKey, setAgentKey] = useState("");
  const [budget, setBudget] = useState("60");
  const [cap, setCap] = useState("40");
  const [hours, setHours] = useState("24");
  const [merchantList, setMerchantList] = useState(Object.keys(MERCHANTS).join("\n"));
  const [demoAgent, setDemoAgent] = useState<Keypair | null>(null);
  useEffect(() => setDemoAgent(loadDemoAgent()), []);

  const refresh = useCallback(async () => {
    if (!program || !wallet) return;
    const owner = wallet.publicKey;
    const ownerFilter = [{ memcmp: { offset: 8, bytes: owner.toBase58() } }];
    const [v, ms, ags, bal] = await Promise.all([
      program.account.creditVault.fetchNullable(vaultOf(owner)),
      program.account.mandate.all(ownerFilter),
      program.account.agreement.all(ownerFilter),
      connection.getTokenAccountBalance(ata(owner)).catch(() => null),
    ]);
    setVault(v);
    setMandates(ms.sort((a: any, b: any) => b.account.createdAt.toNumber() - a.account.createdAt.toNumber()));
    setAgreements(ags.sort((a: any, b: any) => b.account.createdAt.toNumber() - a.account.createdAt.toNumber()));
    setUsdcBalance(bal ? Number(bal.value.uiAmount ?? 0) : 0);
  }, [program, wallet, connection]);

  // Live feed: poll every 4 seconds.
  useEffect(() => {
    refresh().catch(() => {});
    const id = setInterval(() => refresh().catch(() => {}), 4000);
    return () => clearInterval(id);
  }, [refresh]);

  async function run(label: string, fn: () => Promise<string>) {
    setBusy(true);
    setNotice(null);
    try {
      const sig = await fn();
      setNotice({ kind: "ok", text: label, sig });
      await refresh();
    } catch (err) {
      setNotice({ kind: "err", text: explainError(err) });
    } finally {
      setBusy(false);
    }
  }

  const owner = wallet?.publicKey;
  const collateral = vault ? toUsdc(vault.collateral) : 0;
  const line = collateral * 0.8;
  const debt = vault ? toUsdc(vault.debt) : 0;
  const used = line > 0 ? Math.round((debt / line) * 100) : 0;

  const faucet = () =>
    run("Added 500 test USDC to your wallet.", () =>
      program!.methods.faucet(USDC(500)).accountsPartial({ user: owner, pool: POOL, mint: MINT, userUsdc: ata(owner!) }).rpc()
    );

  const depositCollateral = () =>
    run(`Deposited ${deposit} USDC as collateral.`, () =>
      program!.methods
        .depositCollateral(USDC(Number(deposit)))
        .accountsPartial({ owner, vault: vaultOf(owner!), pool: POOL, ownerUsdc: ata(owner!), collateral: COLLATERAL })
        .rpc()
    );

  const createMandate = () =>
    run("Mandate written on-chain. Your agent can now spend inside it.", async () => {
      const agent = new PublicKey(agentKey.trim());
      const allowed = merchantList
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((m) => new PublicKey(MERCHANTS[m] ?? m));
      // The built-in demo agent needs a little devnet SOL for its own fees.
      const fundAgent =
        demoAgent && agent.equals(demoAgent.publicKey)
          ? [SystemProgram.transfer({ fromPubkey: owner!, toPubkey: agent, lamports: 0.03 * LAMPORTS_PER_SOL })]
          : [];
      return program!.methods
        .createMandate({
          budget: USDC(Number(budget)),
          perPurchaseCap: USDC(Number(cap)),
          expiresAt: new BN(Math.floor(Date.now() / 1000) + Number(hours) * 3600),
          allowedMerchants: allowed,
        })
        .accountsPartial({ owner, vault: vaultOf(owner!), agent, mandate: mandateOf(owner!, agent) })
        .preInstructions(fundAgent)
        .rpc();
    });

  const revoke = (mandate: PublicKey) =>
    run("Agent revoked. It cannot spend another cent.", () =>
      program!.methods.revokeMandate().accountsPartial({ owner, mandate }).rpc()
    );

  const repay = (ag: any) =>
    run("Repaid. Your trust record is updated.", () =>
      program!.methods
        .repay(ag.account.amountOwed.sub(ag.account.amountRepaid))
        .accountsPartial({
          owner,
          vault: vaultOf(owner!),
          agreement: ag.publicKey,
          pool: POOL,
          ownerUsdc: ata(owner!),
          liquidity: LIQUIDITY,
        })
        .rpc()
    );

  const active = mandates.filter((m) => !m.account.revoked);

  return (
    <main className="wrap">
      <header className="top">
        <div className="brand">
          <Motif />
          <span>RelicPay Agents</span>
        </div>
        <WalletMultiButton />
      </header>

      <section className="hero">
        <h1>Credit for you and your agent.</h1>
        <p>
          Give your AI agent a company card with a written job description. The rules live on Solana, so even a
          hacked or confused agent cannot overspend.
        </p>
        <p className="tag">Devnet only · mock USDC · not audited</p>
      </section>

      {notice && (
        <div className={`notice ${notice.kind}`} role="status">
          {notice.text}{" "}
          {notice.sig && (
            <a href={explorerTx(notice.sig)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          )}
        </div>
      )}

      {!wallet ? (
        <section className="card center">
          <p>Connect a devnet wallet (Phantom, Solflare or Backpack) to begin.</p>
        </section>
      ) : (
        <div className="grid">
          <section className="card">
            <h2>
              <span className="shape tri" /> Credit line
            </h2>
            <div className="stats">
              <div>
                <label>Collateral</label>
                <b>{collateral.toFixed(2)}</b>
              </div>
              <div>
                <label>Credit line (80%)</label>
                <b>{line.toFixed(2)}</b>
              </div>
              <div>
                <label>Owed</label>
                <b>{debt.toFixed(2)}</b>
              </div>
              <div>
                <label>Loans repaid</label>
                <b>{vault ? vault.loansRepaid : 0}</b>
              </div>
            </div>
            <div className="meter" aria-label={`Credit used ${used}%`}>
              <span style={{ width: `${Math.min(used, 100)}%` }} />
            </div>
            <p className="muted">
              {used}% of your line used · wallet balance {usdcBalance.toFixed(2)} test USDC
            </p>
            <div className="row">
              <input inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} aria-label="Deposit amount" />
              <button disabled={busy} onClick={depositCollateral}>
                Deposit collateral
              </button>
            </div>
            <button className="ghost" disabled={busy} onClick={faucet}>
              Get 500 test USDC
            </button>
          </section>

          <section className="card">
            <h2>
              <span className="shape circ" /> Agent mandate
            </h2>
            <label>Agent public key</label>
            <input value={agentKey} onChange={(e) => setAgentKey(e.target.value)} placeholder="The agent's own address" />
            {demoAgent && (
              <button className="ghost" onClick={() => setAgentKey(demoAgent.publicKey.toBase58())}>
                Use the built-in demo agent
              </button>
            )}
            <div className="row3">
              <div>
                <label>Budget</label>
                <input inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
              </div>
              <div>
                <label>Per purchase</label>
                <input inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
              </div>
              <div>
                <label>Hours</label>
                <input inputMode="numeric" value={hours} onChange={(e) => setHours(e.target.value)} />
              </div>
            </div>
            <label>Approved merchants (names or addresses, up to 5)</label>
            <textarea rows={2} value={merchantList} onChange={(e) => setMerchantList(e.target.value)} />
            <p className="muted">Known: {Object.keys(MERCHANTS).join(", ")}</p>
            <button disabled={busy || !agentKey || !vault} onClick={createMandate}>
              {vault ? "Write mandate" : "Deposit collateral first"}
            </button>

            {active.map((m) => (
              <div key={m.publicKey.toBase58()} className="mandate">
                <p>
                  Agent {m.account.agent.toBase58().slice(0, 6)}... spent {toUsdc(m.account.spent).toFixed(2)} of{" "}
                  {toUsdc(m.account.budget).toFixed(2)} · cap {toUsdc(m.account.perPurchaseCap).toFixed(2)} ·{" "}
                  {m.account.allowedMerchants.map((k: PublicKey) => merchantLabel(k.toBase58())).join(", ")}
                </p>
                <button className="revoke" disabled={busy} onClick={() => revoke(m.publicKey)}>
                  Revoke agent
                </button>
              </div>
            ))}
            {mandates.length > active.length && (
              <p className="muted">{mandates.length - active.length} revoked mandate(s)</p>
            )}
          </section>

          {demoAgent && owner && (
            <AgentConsole
              connection={connection}
              agent={demoAgent}
              owner={owner}
              onDone={() => refresh().catch(() => {})}
            />
          )}

          <section className="card wide">
            <h2>
              <span className="shape sq" /> Agent purchases <small className="live">live</small>
            </h2>
            {agreements.length === 0 && <p className="muted">No agent purchases yet.</p>}
            <ul className="feed">
              {agreements.map((ag) => {
                const a = ag.account;
                const outstanding = toUsdc(a.amountOwed) - toUsdc(a.amountRepaid);
                return (
                  <li key={ag.publicKey.toBase58()}>
                    <div>
                      <b>{toUsdc(a.amountOwed).toFixed(2)} USDC</b> at {merchantLabel(a.merchant.toBase58())}
                      <span className="muted"> · {a.reason || "purchase"} · {new Date(a.createdAt.toNumber() * 1000).toLocaleTimeString()}</span>
                    </div>
                    {a.status === 0 ? (
                      <button disabled={busy} onClick={() => repay(ag)}>
                        Repay {outstanding.toFixed(2)}
                      </button>
                    ) : (
                      <span className="paid">Repaid</span>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      )}

      <footer className="foot">
        Built for the MLH Solana Hackathon on the foundation of{" "}
        <a href="https://github.com/walthova/relicpay-v2" target="_blank" rel="noreferrer">
          RelicPay v2
        </a>
        .
      </footer>
    </main>
  );
}
