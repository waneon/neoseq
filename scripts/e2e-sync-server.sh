#!/usr/bin/env bash
# Runs a synchronization server for browser verification on its own throwaway
# PostgreSQL cluster. The cluster listens only on a socket inside a private
# temporary directory, so concurrent runs (other checkouts, other agents) never
# share a port or a database. Everything is removed when the server stops.
#
# Required environment: NEOSEQ_BIND, NEOSEQ_BOOTSTRAP_ADMIN_USERNAME,
# NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD.
set -euo pipefail

: "${NEOSEQ_BIND:?NEOSEQ_BIND is required}"
: "${NEOSEQ_BOOTSTRAP_ADMIN_USERNAME:?NEOSEQ_BOOTSTRAP_ADMIN_USERNAME is required}"
: "${NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD:?NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD is required}"

cd "$(dirname "$0")/.."
cargo build --locked -p neoseq-server
server="$PWD/target/debug/neoseq-server"

# A short base keeps the socket path within the platform's length limit.
cluster="$(mktemp -d /tmp/neoseq-e2e.XXXXXX)"
server_pid=""

# shellcheck disable=SC2329 # Invoked by the EXIT trap.
cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  pg_ctl --pgdata "$cluster/data" --mode immediate stop >/dev/null 2>&1 || true
  rm -rf "$cluster"
}
trap cleanup EXIT
trap 'exit 143' INT TERM

initdb --pgdata "$cluster/data" --auth trust --username postgres --encoding UTF8 --no-locale \
  --no-sync >/dev/null
pg_ctl --pgdata "$cluster/data" --log "$cluster/postgres.log" --wait \
  --options "-c listen_addresses='' -k $cluster -c fsync=off" start >/dev/null
createdb --host "$cluster" --username postgres neoseq

export DATABASE_URL="postgresql:///neoseq?host=$cluster&user=postgres"
"$server" &
server_pid="$!"
wait "$server_pid"
