// Browser client: PDAs, program handle, and plain-English errors.

import { AnchorProvider, Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import { Buffer } from "buffer";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { AnchorWallet } from "@solana/wallet-adapter-react";
import idl from "./idl.json";
import merchants from "./merchants.json";

export const RPC_URL = process.env.NEXT_PUBLIC_RPC_URL ?? "https://api.devnet.solana.com";
export const PROGRAM_ID = new PublicKey((idl as any).address);
export const MERCHANTS: Record<string, string> = merchants;
export const merchantLabel = (key: string) =>
  Object.entries(MERCHANTS).find(([, k]) => k === key)?.[0] ?? `${key.slice(0, 4)}...${key.slice(-4)}`;

export const USDC = (n: number) => new BN(Math.round(n * 1_000_000));
export const toUsdc = (raw: BN | number) => Number(raw.toString()) / 1_000_000;
export const explorerTx = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const pda = (...seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
export const POOL = pda(Buffer.from("pool"));
export const MINT = pda(Buffer.from("mock_usdc"));
export const LIQUIDITY = pda(Buffer.from("liquidity"));
export const COLLATERAL = pda(Buffer.from("collateral"));
export const vaultOf = (owner: PublicKey) => pda(Buffer.from("vault"), owner.toBuffer());
export const mandateOf = (owner: PublicKey, agent: PublicKey) =>
  pda(Buffer.from("mandate"), owner.toBuffer(), agent.toBuffer());
export const ata = (owner: PublicKey) => getAssociatedTokenAddressSync(MINT, owner);

export function programFor(connection: Connection, wallet: AnchorWallet): any {
  return new Program(idl as any, new AnchorProvider(connection, wallet, { commitment: "confirmed" }));
}

const ERRORS: Record<string, string> = Object.fromEntries(
  ((idl as any).errors ?? []).map((e: any) => [e.name.charAt(0).toUpperCase() + e.name.slice(1), e.msg])
);

export function explainError(err: any): string {
  const code: string | undefined =
    err?.error?.errorCode?.code ?? String(err?.logs?.join(" ") ?? err).match(/Error Code: (\w+)/)?.[1];
  if (code && ERRORS[code]) return ERRORS[code];
  const msg = String(err?.message ?? err);
  if (msg.includes("User rejected")) return "You cancelled the transaction in your wallet.";
  return msg.split("\n")[0];
}
