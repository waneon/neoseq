#!/usr/bin/env bash
# Builds the development Wasm core and its JavaScript bindings into the client.
# Shared by the `wasm:build-dev` task and browser verification, which must not
# serve a stale core. Cargo makes an up-to-date build a no-op.
set -euo pipefail

cd "$(dirname "$0")/.."

cargo build --locked --release --target wasm32-unknown-unknown -p platform-web
wasm-bindgen \
  --target web \
  --out-dir apps/client/src/wasm \
  --out-name neoseq_core \
  target/wasm32-unknown-unknown/release/platform_web.wasm
