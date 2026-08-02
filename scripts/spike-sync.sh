#!/usr/bin/env bash
set -euo pipefail

if [[ -f "$PWD/Cargo.toml" ]]; then
  workspace_root="$PWD"
else
  workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
cd "$workspace_root"

bash scripts/build-wasm-bindings.sh
cargo build --locked --quiet -p sync-server -p platform-native

relay_log="$(mktemp)"
wasm_log="$(mktemp)"
native_log="$(mktemp)"
cleanup() {
  kill "${relay_pid:-}" 2>/dev/null || true
  rm -f "$relay_log" "$wasm_log" "$native_log"
}
trap cleanup EXIT

target/debug/spike-relay 127.0.0.1:39091 >"$relay_log" 2>&1 &
relay_pid=$!
for _ in $(seq 1 50); do
  if grep -q '127.0.0.1:39091' "$relay_log"; then break; fi
  sleep 0.1
done
grep -q '127.0.0.1:39091' "$relay_log"

node scripts/wasm-sync-peer.mjs ws://127.0.0.1:39091 >"$wasm_log" &
wasm_pid=$!
target/debug/native-sync-peer ws://127.0.0.1:39091 >"$native_log" &
native_pid=$!
wait "$wasm_pid"
wait "$native_pid"

wasm_hash="$(jq -r .fixture_hash "$wasm_log")"
native_hash="$(jq -r .fixture_hash "$native_log")"
test "$native_hash" = "$wasm_hash"
jq -n --arg native "$native_hash" --arg wasm "$wasm_hash" \
  '{native_hash:$native,wasm_hash:$wasm,status:"passed"}'
