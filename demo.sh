#!/usr/bin/env bash
# RelicPay Agents demo. Devnet by default; RPC_URL=http://127.0.0.1:8899 for local.
# Add --claude to have Claude parse each agent request (needs ANTHROPIC_API_KEY).
set -euo pipefail
cd "$(dirname "$0")"
npm run --silent demo -- "$@"
