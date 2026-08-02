#!/usr/bin/env bash
set -euo pipefail

workspace_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$workspace_root"

cargo build --locked --release --target wasm32-unknown-unknown -p platform-web
rm -rf target/step1-wasm-node target/step1-wasm-web
wasm-bindgen target/wasm32-unknown-unknown/release/platform_web.wasm \
  --target nodejs \
  --out-dir target/step1-wasm-node \
  --out-name neoseq_core
wasm-bindgen target/wasm32-unknown-unknown/release/platform_web.wasm \
  --target web \
  --out-dir target/step1-wasm-web \
  --out-name neoseq_core

mkdir -p apps/client/src/wasm
cp target/step1-wasm-web/neoseq_core.js apps/client/src/wasm/neoseq_core.js
cp target/step1-wasm-web/neoseq_core.d.ts apps/client/src/wasm/neoseq_core.d.ts
cp target/step1-wasm-web/neoseq_core_bg.wasm apps/client/src/wasm/neoseq_core_bg.wasm
cp target/step1-wasm-web/neoseq_core_bg.wasm.d.ts apps/client/src/wasm/neoseq_core_bg.wasm.d.ts
