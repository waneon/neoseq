#!/usr/bin/env bash
# Runs a command against its own throwaway PostgreSQL cluster. The cluster
# listens only on a socket inside a private temporary directory, so concurrent
# runs (other checkouts, other agents) never share a port or a database.
# Everything is removed when the command exits.
set -euo pipefail

if (($# == 0)); then
  echo "usage: with-test-database <command> [argument ...]" >&2
  exit 64
fi

# A short base keeps the socket path within the platform's length limit.
cluster="$(mktemp -d /tmp/neoseq-db.XXXXXX)"
child_pid=""

# shellcheck disable=SC2329 # Invoked by the EXIT trap.
cleanup() {
  if [[ -n "$child_pid" ]]; then
    kill "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null || true
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
"$@" &
child_pid="$!"
set +e
wait "$child_pid"
status="$?"
set -e
child_pid=""
exit "$status"
