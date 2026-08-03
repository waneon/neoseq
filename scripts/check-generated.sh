#!/usr/bin/env bash
set -euo pipefail

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

cp crates/domain/src/generated/core_port.rs "$tmp_dir/core_port.rs"
cp apps/client/src/generated/core-port.ts "$tmp_dir/core-port.ts"
node scripts/generate-contracts.mjs
diff -u "$tmp_dir/core_port.rs" crates/domain/src/generated/core_port.rs
diff -u "$tmp_dir/core-port.ts" apps/client/src/generated/core-port.ts
diff -u fixtures/core-port/v1.json apps/client/public/core-port-v1.json
