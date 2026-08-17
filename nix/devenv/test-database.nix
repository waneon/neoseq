{
  coreutils,
  postgresql,
  writeShellApplication,
}:

writeShellApplication {
  name = "with-test-database";
  runtimeInputs = [
    postgresql
    coreutils
  ];
  text = ''
    set -euo pipefail

    if [[ "$#" -eq 0 ]]; then
      echo "usage: with-test-database <command> [argument ...]" >&2
      exit 64
    fi
    : "''${PGHOST:?PGHOST must point to the managed PostgreSQL service}"

    suffix="$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
    database="neoseq_test_$suffix"
    child_pid=""

    # shellcheck disable=SC2329 # Invoked by the EXIT trap.
    drop_database() {
      dropdb --if-exists --force --maintenance-db=postgres "$database" >/dev/null
    }
    # shellcheck disable=SC2329 # Invoked by the signal traps.
    terminate() {
      if [[ -n "$child_pid" ]]; then
        kill "$child_pid" 2>/dev/null || true
        wait "$child_pid" 2>/dev/null || true
        child_pid=""
      fi
      exit 143
    }

    createdb --maintenance-db=postgres "$database"
    trap drop_database EXIT
    trap terminate INT TERM
    export DATABASE_URL="postgresql:///$database?host=$PGHOST"

    "$@" &
    child_pid="$!"
    set +e
    wait "$child_pid"
    status="$?"
    set -e
    child_pid=""
    exit "$status"
  '';
}
