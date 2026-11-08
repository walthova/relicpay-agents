// The AI agent. Holds ONLY its own scoped keypair, never the owner's key.
//
//   npm run agent -- "buy the $40 print from IBG Shop"
//
// With ANTHROPIC_API_KEY set, Claude turns the request into
// { merchant, amount, reason }. Without it, a simple local parser is used, so
// the demo never depends on an API key. Either way the program on-chain has
// the final say: the agent can only ask, the mandate decides.

import Anthropic from "@anthropic-ai/sdk";
import fs from "fs";
import path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  MERCHANTS,
  MINT,
  POOL,
  LIQUIDITY,
  USDC,
  agreementOf,
  ata,
  explainError,
  explorerTx,
  fmt,
  loadKeypair,
  mandateOf,
  merchantName,
  programFor,
  status,
  vaultOf,
} from "../client/relic";

export type Intent = { merchant: string; amount: number; reason: string };

const INTENT_TOOL = {
  name: "record_purchase_intent",
  description:
    "Record the single purchase the user is asking for. merchant is the shop name exactly as listed, " +
    "or a raw Solana address if the request names one.",
  input_schema: {
    type: "object" as const,
    properties: {
      merchant: { type: "string", description: `One of: ${Object.keys(MERCHANTS).join(", ")}, or a Solana address` },
      amount: { type: "number", description: "Price in USDC" },
      reason: { type: "string", description: "What is being bought, under 60 characters" },
    },
    required: ["merchant", "amount", "reason"],
  },
};

/** Claude parses the request; falls back to a local parser without a key. */
export async function parseIntent(request: string): Promise<Intent> {
  if (!process.env.ANTHROPIC_API_KEY) return localParse(request);
  const client = new Anthropic();
  const msg = await client.messages.create({
    model: "claude-opus-5-5",
    max_tokens: 1024,
    system:
      "You turn a shopping request into one purchase intent for a payments agent. " +
      "Extract what the text says; do not invent a merchant or amount.",
    tools: [INTENT_TOOL],
    tool_choice: { type: "tool", name: INTENT_TOOL.name },
    messages: [{ role: "user", content: request }],
  });
  const block = msg.content.find((b) => b.type === "tool_use");
  if (!block || block.type !== "tool_use") throw new Error("Claude did not return a purchase intent");
  const input = block.input as Intent;
  return { merchant: String(input.merchant), amount: Number(input.amount), reason: String(input.reason).slice(0, 60) };
}

function localParse(request: string): Intent {
  const amount = Number(request.match(/\$?\s*(\d+(?:\.\d+)?)/)?.[1] ?? NaN);
  const address = request.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/)?.[0];
  const named = Object.keys(MERCHANTS).find((n) => request.toLowerCase().includes(n.toLowerCase()));
  const merchant = address ?? named;
  if (!merchant || !Number.isFinite(amount)) throw new Error(`Could not understand: "${request}"`);
  return { merchant, amount, reason: request.replace(/\s+/g, " ").slice(0, 60) };
}

function resolveMerchant(m: string): PublicKey {
  const named = Object.entries(MERCHANTS).find(([n]) => n.toLowerCase() === m.toLowerCase());
  return named ? named[1] : new PublicKey(m);
}

export type ActResult = { ok: boolean; sig?: string; code?: string; message?: string };

/** Preview, then send. Reports whether the chain accepted the purchase. */
export async function act(agent: Keypair, owner: PublicKey, intent: Intent, log = console.log): Promise<ActResult> {
  const merchant = resolveMerchant(intent.merchant);
  const { mandate, line, debt } = await status(owner, agent.publicKey);
  if (!mandate) {
    log("  No mandate exists for this agent. The owner has not given it permission to spend.");
    return { ok: false, code: "NoMandate" };
  }
  const amount = USDC(intent.amount);
  const remainingAfter = Number(mandate.budget.sub(mandate.spent).sub(amount).toString());
  const usedAfter = line > 0 ? Math.round(((debt + Number(amount.toString())) / line) * 100) : 0;
  log(
    `  Preview: agent will spend ${intent.amount} USDC at ${merchantName(merchant)} for "${intent.reason}".\n` +
      `           Mandate remaining after: ${fmt(Math.max(remainingAfter, 0))} USDC. ` +
      `Credit line used after: ${usedAfter}%.`
  );

  try {
    const sig = await programFor(agent)
      .methods.agentPurchase(amount, intent.reason)
      .accountsPartial({
        agent: agent.publicKey,
        mandate: mandateOf(owner, agent.publicKey),
        vault: vaultOf(owner),
        pool: POOL,
        mint: MINT,
        liquidity: LIQUIDITY,
        merchant,
        merchantUsdc: ata(merchant),
        agreement: agreementOf(mandateOf(owner, agent.publicKey), mandate.purchases),
      })
      .rpc();
    log(`  APPROVED on-chain. ${merchantName(merchant)} paid ${intent.amount} USDC up front by the pool.`);
    log(`  ${explorerTx(sig)}`);
    return { ok: true, sig };
  } catch (err) {
    const { code, message } = explainError(err);
    log(`  BLOCKED on-chain (${code}): ${message}`);
    return { ok: false, code, message };
  }
}

if (require.main === module) {
  (async () => {
    const request = process.argv.slice(2).join(" ");
    if (!request) throw new Error('Usage: npm run agent -- "buy the $40 print from IBG Shop"');
    // The agent never loads the owner's secret key: only the owner's public
    // address, from OWNER or from the last demo run.
    const last = JSON.parse(fs.readFileSync(path.join(__dirname, "..", ".keys", "last-demo.json"), "utf8"));
    const agent = loadKeypair(process.env.AGENT_KEY ?? last.agentKeyFile);
    const owner = new PublicKey(process.env.OWNER ?? last.owner);
    console.log(`Agent ${agent.publicKey.toBase58()} acting for owner ${owner.toBase58()}`);
    console.log(`Request: "${request}"`);
    const intent = await parseIntent(request);
    console.log(`  Understood (${process.env.ANTHROPIC_API_KEY ? "Claude" : "local parser"}):`, intent);
    await act(agent, owner, intent);
  })().catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  });
}
