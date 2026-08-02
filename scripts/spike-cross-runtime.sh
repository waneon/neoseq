#!/usr/bin/env bash
set -euo pipefail

if [[ -f "$PWD/Cargo.toml" ]]; then
  workspace_root="$PWD"
else
  workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
cd "$workspace_root"

bash scripts/build-wasm-bindings.sh
native_hash="$(cargo run --locked --quiet -p graph-core --bin core-fixture -- hash)"
wasm_hash="$(node scripts/wasm-hash.mjs)"
test "$native_hash" = "$wasm_hash"
printf '{"native_hash":"%s","wasm_hash":"%s","status":"passed"}\n' \
  "$native_hash" "$wasm_hash"
