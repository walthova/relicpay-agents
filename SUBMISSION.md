# MLH Solana Hackathon submission (draft, review before submitting)

**Project name:** RelicPay Agents

**Tagline:** AI agents that buy now, pay later on your behalf, inside on-chain rules they cannot bypass.

**Tracks:** AI Track, DeFi Track

**Repo:** https://github.com/walthova/relicpay-agents

**Program (devnet):** `HwMQv76mcuPCMmoW3APdn3ceqikHWoWRq1YVy5n3PurH`

## What it does

Give your AI agent a company card with a written job description. The owner deposits USDC collateral and gets an 80% credit line. They write a mandate for their agent on-chain: a total budget, a per-purchase cap, up to five approved merchants, and an expiry. The agent signs purchases with its own scoped key. The program checks every rule, a liquidity pool pays the merchant up front, and the owner repays over time. Every full repayment raises the owner's on-chain trust record. One tap revokes the agent.

## The problem

AI agents are becoming buyers, paying in stablecoins over rails like x402. Today an agent either holds a wallet full of money, where one prompt injection empties it, or it cannot pay at all. Almost nobody offers agents credit.

## How we built it

- Anchor 0.32.1 program on Solana devnet: CreditVault, Pool, Mandate, and Agreement PDAs. Checked math, `has_one` and signer constraints, PDA seed validation, and plain-English custom errors.
- 18 Anchor tests: the happy path plus every rejection, including the agent trying to raise its own limits or revoke its own mandate.
- A TypeScript agent that holds only its own key. Claude parses a plain-English request into `{merchant, amount, reason}`, the agent previews the spend, sends it, and explains any on-chain rejection in plain English.
- A Next.js dashboard with Solana wallet adapter: deposit collateral, write a mandate, watch a live feed of agent purchases, hit the big red Revoke button, and repay.

## Demo highlights

The agent buys a 40 USDC print and the merchant is paid instantly. The agent then tries a 50 USDC item and is blocked (over the cap). It falls for a prompt injection and tries to pay an unknown wallet, and is blocked (merchant not approved). The owner revokes it, and its next purchase is blocked. The owner repays, and the trust record goes up.

**The model can be fooled. The mandate cannot.**

## Why Solana

Sub-second settlement, fractions of a cent per transaction, and rules enforced by a program the agent cannot bypass.

## Challenges

Designing the agent's authority so it can spend but never move collateral, change its own limits, or undo a revoke, and proving each of those in tests.

## What's next

x402 integration, agent identity (KYA or ERC-8004), repayment schedules and interest, liquidation, and an independent audit before mainnet.

## Built during the hackathon

Everything in this repo was built during the hackathon. It builds on our earlier RelicPay v2 protocol (https://github.com/walthova/relicpay-v2) as prior context.

Devnet only, mock USDC, not audited.
