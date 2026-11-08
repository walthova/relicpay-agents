// Shared client for the agent, the demo, and scripts.
// Devnet by default. Set RPC_URL=http://127.0.0.1:8899 to run against a local validator.

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import fs from "fs";
import path from "path";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import idl from "../idl/relicpay_agents.json";
import merchants from "./merchants.json";

export const RPC_URL = process.env.RPC_URL ?? "https://api.devnet.solana.com";
export const PROGRAM_ID = new PublicKey((idl as any).address);
export const MERCHANTS: Record<string, PublicKey> = Object.fromEntries(
  Object.entries(merchants).map(([name, key]) => [name, new PublicKey(key as string)])
);
export const merchantName = (key: PublicKey) =>
  Object.entries(MERCHANTS).find(([, k]) => k.equals(key))?.[0] ?? key.toBase58();

export const USDC = (n: number) => new BN(Math.round(n * 1_000_000));
export const fmt = (raw: BN | number | bigint) => (Number(raw.toString()) / 1_000_000).toFixed(2);

export const cluster = RPC_URL.includes("devnet") ? "devnet" : `custom&customUrl=${encodeURIComponent(RPC_URL)}`;
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=${cluster}`;
export const explorerAddr = (a: PublicKey) =>
  `https://explorer.solana.com/address/${a.toBase58()}?cluster=${cluster}`;

const KEYS_DIR = path.join(__dirname, "..", ".keys");

export function loadKeypair(file: string): Keypair {
  const p = path.isAbsolute(file) ? file : path.join(KEYS_DIR, file);
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
}

export function saveKeypair(file: string, kp: Keypair) {
  const p = path.join(KEYS_DIR, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
}

export const connection = new Connection(RPC_URL, "confirmed");

/** A program client that signs as `signer`. */
export function programFor(signer: Keypair): Program<any> {
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(signer), {
    commitment: "confirmed",
  });
  return new Program(idl as any, provider);
}

const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
export const POOL = pda(Buffer.from("pool"));
export const MINT = pda(Buffer.from("mock_usdc"));
export const LIQUIDITY = pda(Buffer.from("liquidity"));
export const COLLATERAL = pda(Buffer.from("collateral"));
export const vaultOf = (owner: PublicKey) => pda(Buffer.from("vault"), owner.toBuffer());
export const mandateOf = (owner: PublicKey, agent: PublicKey) =>
  pda(Buffer.from("mandate"), owner.toBuffer(), agent.toBuffer());
export const agreementOf = (mandate: PublicKey, index: number) => {
  const idx = Buffer.alloc(4);
  idx.writeUInt32LE(index);
  return pda(Buffer.from("agreement"), mandate.toBuffer(), idx);
};
export const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(MINT, owner);
export const PROGRAM_DATA = PublicKey.findProgramAddressSync(
  [PROGRAM_ID.toBuffer()],
  new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
)[0];

const ERRORS: Record<string, string> = Object.fromEntries(
  ((idl as any).errors ?? []).map((e: any) => [e.name.charAt(0).toUpperCase() + e.name.slice(1), e.msg])
);

/** Turns any failed transaction into { code, message } in plain English. */
export function explainError(err: any): { code: string; message: string } {
  const code: string | undefined =
    err?.error?.errorCode?.code ??
    String(err?.logs?.join(" ") ?? err).match(/Error Code: (\w+)/)?.[1];
  if (code && ERRORS[code]) return { code, message: ERRORS[code] };
  if (code === "ConstraintSeeds" || code === "ConstraintHasOne")
    return { code, message: "Blocked: this key is not allowed to act on that account." };
  return { code: code ?? "Unknown", message: String(err?.message ?? err).split("\n")[0] };
}

/** Owner credit + mandate status, for previews. */
export async function status(owner: PublicKey, agent: PublicKey) {
  const reader = programFor(Keypair.generate());
  const vault: any = await reader.account.creditVault.fetchNullable(vaultOf(owner));
  const mandate: any = await reader.account.mandate.fetchNullable(mandateOf(owner, agent));
  const collateral = vault ? Number(vault.collateral.toString()) : 0;
  const line = Math.floor((collateral * 8000) / 10000);
  const debt = vault ? Number(vault.debt.toString()) : 0;
  return { vault, mandate, collateral, line, debt };
}
