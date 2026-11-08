import type { AppProps } from "next/app";
import Head from "next/head";
import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import "../styles/globals.css";
import { RPC_URL } from "../lib/relic";

export default function App({ Component, pageProps }: AppProps) {
  // Wallet Standard wallets (Phantom, Solflare, Backpack) are detected automatically.
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={RPC_URL}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Head>
            <title>RelicPay Agents</title>
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <meta name="description" content="Credit for you and your agent. Devnet demo." />
          </Head>
          <Component {...pageProps} />
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
