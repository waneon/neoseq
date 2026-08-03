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
native_scenario="$(cargo run --locked --quiet -p graph-core --bin core-scenario -- fixtures/core/basic.yaml)"
wasm_scenario="$(node scripts/wasm-scenario.mjs)"
test "$native_scenario" = "$wasm_scenario"
scenario_hash="$(printf '%s' "$native_scenario" | sha256sum | cut -d' ' -f1)"
printf '{"native_hash":"%s","wasm_hash":"%s","core_scenario_hash":"%s","status":"passed"}\n' \
  "$native_hash" "$wasm_hash" "$scenario_hash"
