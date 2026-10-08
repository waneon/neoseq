#!/usr/bin/env bash
# Runs a synchronization server for browser verification on its own throwaway
# PostgreSQL cluster.
#
# Required environment: NEOSEQ_BIND, NEOSEQ_BOOTSTRAP_ADMIN_USERNAME,
# NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD.
set -euo pipefail

: "${NEOSEQ_BIND:?NEOSEQ_BIND is required}"
: "${NEOSEQ_BOOTSTRAP_ADMIN_USERNAME:?NEOSEQ_BOOTSTRAP_ADMIN_USERNAME is required}"
: "${NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD:?NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD is required}"

cd "$(dirname "$0")/.."
cargo build --locked -p neoseq-server
exec scripts/with-test-database.sh target/debug/neoseq-server
