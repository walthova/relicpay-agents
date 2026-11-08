#!/usr/bin/env bash
# Deploys relicpay_agents to DEVNET with the project deployer key, then
# creates the pool. Never targets mainnet.
set -euo pipefail
cd "$(dirname "$0")/.."
solana balance .keys/deployer.json --url devnet
anchor build
anchor deploy --provider.cluster devnet
echo "Deployed. Run ./demo.sh to create the pool and play the demo."
