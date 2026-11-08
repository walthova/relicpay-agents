# RelicPay Agents

**The first protocol where AI agents can buy now, pay later on your behalf, safely.**

Give your agent a company card with a written job description. The rules live on-chain, so even a hacked or confused agent cannot overspend.

> **Devnet only. Mock USDC. Not audited.** This is a hackathon build. Do not use real funds.

## The problem

AI agents are becoming buyers. They pay in stablecoins over rails like x402. But today an agent either holds a wallet full of money (one prompt injection and it is gone) or it cannot pay at all. And almost nobody offers agents **credit**.

## How it works

```
   OWNER (keeps their keys)                         AGENT (its own scoped key)
        │                                                   │
        │ 1. deposit 125 USDC collateral                    │
        ▼                                                   │
  ┌──────────────┐   credit line = 80% LTV = 100 USDC        │
  │ CreditVault  │                                           │
  └──────────────┘                                           │
        │ 2. write the job description                       │
        ▼                                                    │
  ┌──────────────┐  budget 60 · 40 per purchase              │
  │   Mandate    │  IBG Shop only · expires in 24h  ◄────────┤ 3. agent_purchase(40, "IBG print")
  └──────────────┘  revocable in one tap                     │    signed ONLY by the agent key
        │                                                    │
        │  program checks EVERY rule before any USDC moves:  │
        │  revoked? expired? merchant approved? under cap?   │
        │  under budget? debt stays within 80% LTV?          │
        ▼                                                    │
  ┌──────────────┐  pays the merchant up front               │
  │     Pool     │ ──────────────────────────────► IBG Shop  │
  └──────────────┘                                           │
        ▲                                                    │
        │ 4. owner repays; trust record goes up              │
  ┌──────────────┐                                           │
  │  Agreement   │  amount owed · repaid · status · reason   │
  └──────────────┘                                           │
```

**What the agent key cannot do,** enforced by the program (and proven in tests):

| The agent tries to... | Result |
|---|---|
| Spend over the per-purchase cap | `OverPurchaseCap` |
| Spend past its total budget | `OverBudget` |
| Pay a wallet the owner never approved (prompt injection) | `MerchantNotAllowed` |
| Push the owner past the 80% credit line | `ExceedsCreditLine` |
| Keep spending after the owner revokes | `MandateRevoked` |
| Spend after the mandate expires | `MandateExpired` |
| Raise its own limits | `NotMandateOwner` |
| Revoke or un-revoke anything | `NotMandateOwner` |
| Touch the owner's collateral | rejected (account constraint) |

Every error has a plain-English message that the agent reads back to the owner.

## Why Solana

- **Sub-second settlement:** the merchant is paid while the agent is still in checkout.
- **Fractions of a cent per transaction:** micro-purchases by agents make economic sense.
- **On-chain rules agents cannot bypass:** the mandate is enforced by the program, not by a prompt or an API key the agent could leak.

## Program

- Program ID (devnet): `HwMQv76mcuPCMmoW3APdn3ceqikHWoWRq1YVy5n3PurH`
- Explorer: https://explorer.solana.com/address/HwMQv76mcuPCMmoW3APdn3ceqikHWoWRq1YVy5n3PurH?cluster=devnet
- **Live on devnet** (deployed 2026-11-08). A real run of `./demo.sh`:
  - [Agent buys a 40 USDC print, merchant paid up front](https://explorer.solana.com/tx/41crLpKZLrcwe2Rp3YWYB8kZ7AiJv449pxa7YAovLc8fEAiGiotcThJJyknQ7b3X6EvcbxJKsViyf4MR9229MsC6?cluster=devnet)
  - [Owner writes the mandate](https://explorer.solana.com/tx/2JRX7r4JguokfkrZeuA2WxaS4JX2wpFmP5AWntJ361dLgtvzzhq4mSZzpNrAnNc22bQFp7vWE44ZZVrH7XjbFpFw?cluster=devnet)
  - [Owner revokes the agent in one transaction](https://explorer.solana.com/tx/45QDuFsKiNd7ph8WAgJ7E74rSZVQw2cpf8zhd2idzFZwhZozawVo12dpg7vZN497Bv3TCSAKs7HLgBK88HRqFWAy?cluster=devnet)
  - [Owner repays; trust record goes up](https://explorer.solana.com/tx/29M9cj5x2tJWdTySxq9mEF2RYoz4aiREYeXCUrMGWcdXjwnrcodS7mDRc4Qt9Lhs8MwQGnZ4d8SUtNWZ1wGBJEvH?cluster=devnet)
  - The over-cap, prompt-injection and post-revoke attempts were all rejected by the program before any USDC moved, so they leave no successful transaction.
- Anchor 0.32.1. Checked math everywhere, `has_one` and signer constraints on every owner action, PDA seed validation on every account, pool initialization gated on the program's upgrade authority.

| Instruction | Signer | What it does |
|---|---|---|
| `init_pool` | deployer only | Creates the pool, the mock USDC mint, and seeds liquidity |
| `faucet` | anyone | Up to 1,000 mock USDC per call (devnet demo only) |
| `deposit_collateral` / `withdraw_collateral` | owner | Collateral in; out only while debt stays within 80% LTV |
| `create_mandate` / `update_mandate` | owner | The agent's job description |
| `revoke_mandate` | owner | The big red button |
| `agent_purchase` | **agent only** | Checks every rule, pool pays merchant, records the debt |
| `repay` | owner | Repays the pool; full repayment raises the trust record |

## Run it

Requirements: Rust, Solana CLI, Anchor 0.32.1, Node 22.12+.

```bash
npm install
anchor build && anchor test          # 18 tests: happy path + every rejection

# Demo on devnet (needs a funded .keys/deployer.json; keys are gitignored)
./demo.sh                            # hardcoded requests, no API key needed
ANTHROPIC_API_KEY=... ./demo.sh --claude   # Claude parses each request

# Talk to the agent directly after a demo run
npm run agent -- "buy the \$40 print from IBG Shop"

# Dashboard
cd app && npm install && npm run dev  # http://localhost:3100
```

Run everything locally instead of devnet: start `solana-test-validator` with the program loaded, then prefix commands with `RPC_URL=http://127.0.0.1:8899` (dashboard: `NEXT_PUBLIC_RPC_URL`).

## The agent

`agent/agent.ts` holds **only its own keypair**. It never loads the owner's key.

1. Takes a plain-English request: "buy the $40 print from IBG Shop".
2. Claude (`claude-opus-5-5`, key from `ANTHROPIC_API_KEY` only) turns it into `{ merchant, amount, reason }`. Without a key, a local parser does the same for the demo.
3. Prints a preview: "Agent will spend 40 USDC at IBG Shop. Mandate remaining after: 20 USDC. Credit line used: 40%."
4. Sends `agent_purchase`. If the chain says no, it explains why in plain English.

The model can be fooled. The mandate cannot.

## Tracks

MLH Solana Hackathon: **AI Track**, **DeFi Track**, Top 3 Overall.

## Built during the hackathon

This repo, the `relicpay_agents` program, agent, dashboard, and demo were built during the hackathon. It builds on ideas from [RelicPay v2](https://github.com/walthova/relicpay-v2), our earlier self-custody credit wallet and decentralized BNPL protocol on Solana (prior work, separate repo).

## Status and limits

Devnet only, mock USDC, not audited. Not built yet: interest and repayment schedules, liquidation, agent identity (KYA / ERC-8004), x402 integration. An independent audit comes before any mainnet use.
