#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$workspace_root"

bash scripts/build-wasm-bindings.sh
database="$(mktemp -d)/step-1.sqlite"
cargo run --locked --quiet -p platform-native --bin native-spike -- persistence "$database"
pnpm --filter @neoseq/client build
pnpm --filter @neoseq/client test:indexeddb
