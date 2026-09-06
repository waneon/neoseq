#!/usr/bin/env bash

set -Eeuo pipefail

readonly image_archive="${1:?usage: smoke-appliance.sh IMAGE_ARCHIVE}"
readonly resource_prefix="neoseq-smoke-${GITHUB_RUN_ID:-local}-${GITHUB_RUN_ATTEMPT:-0}-$$"
readonly container="${resource_prefix}-app"
readonly restore_container="${resource_prefix}-restore"
readonly data_volume="${resource_prefix}-data"
readonly backup_volume="${resource_prefix}-backups"
readonly fresh_data_volume="${resource_prefix}-fresh-data"

image=""

diagnose_container() {
  local name="$1"

  if ! docker inspect "$name" >/dev/null 2>&1; then
    return
  fi

  printf '\nDiagnostics for %s:\n' "$name" >&2
  docker inspect \
    --format 'status={{.State.Status}} exit={{.State.ExitCode}} error={{printf "%q" .State.Error}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}unavailable{{end}}' \
    "$name" >&2 || true
  docker inspect \
    --format '{{if .State.Health}}{{range .State.Health.Log}}health check: started={{.Start}} exit={{.ExitCode}} output={{printf "%q" .Output}}{{println}}{{end}}{{end}}' \
    "$name" >&2 || true
  docker logs "$name" >&2 || true
}

cleanup() {
  local status=$?

  trap - EXIT INT TERM
  if ((status != 0)); then
    diagnose_container "$container"
    diagnose_container "$restore_container"
  fi
  docker rm --force "$restore_container" "$container" >/dev/null 2>&1 || true
  docker volume rm --force "$data_volume" "$fresh_data_volume" "$backup_volume" >/dev/null 2>&1 || true
  exit "$status"
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

wait_for_health() {
  local deadline=$((SECONDS + 120))
  local health
  local state

  while ((SECONDS < deadline)); do
    state="$(docker inspect --format '{{.State.Status}}' "$container")"
    health="$(
      docker inspect \
        --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}unavailable{{end}}' \
        "$container"
    )"

    if [[ "$state" == "running" && "$health" == "healthy" ]]; then
      return
    fi
    if [[ "$state" != "running" ]]; then
      printf 'container stopped before becoming healthy (state=%s, health=%s)\n' \
        "$state" "$health" >&2
      return 1
    fi

    sleep 1
  done

  printf 'container did not become healthy within 120 seconds\n' >&2
  return 1
}

published_port() {
  local container_port="$1"
  local binding

  binding="$(docker port "$container" "${container_port}/tcp" | head -n 1)"
  if [[ ! "$binding" =~ :([0-9]+)$ ]]; then
    printf 'could not determine the published port for %s from %q\n' \
      "$container_port" "$binding" >&2
    return 1
  fi
  printf '%s\n' "${BASH_REMATCH[1]}"
}

assert_roots_and_readiness() {
  local public_port
  local dashboard_port
  local page
  local ready

  # Docker may allocate new host ports when the container restarts.
  public_port="$(published_port 8080)"
  dashboard_port="$(published_port 8081)"

  page="$(
    curl --fail --silent --show-error --max-time 10 \
      "http://127.0.0.1:${public_port}/"
  )"
  [[ "$page" == *'<title>Neoseq</title>'* ]] || {
    printf 'public root did not serve the Neoseq client\n' >&2
    return 1
  }
  page="$(
    curl --fail --silent --show-error --max-time 10 \
      "http://127.0.0.1:${dashboard_port}/"
  )"
  [[ "$page" == *'<title>Neoseq Dashboard</title>'* ]] || {
    printf 'dashboard root did not serve the Neoseq dashboard\n' >&2
    return 1
  }
  ready="$(
    curl --fail --silent --show-error --max-time 10 \
      "http://127.0.0.1:${public_port}/readyz"
  )"
  if [[ "$ready" != "ready" ]]; then
    printf 'unexpected readiness response: %q\n' "$ready" >&2
    return 1
  fi
}

if [[ ! -e "$image_archive" ]]; then
  printf 'image archive does not exist: %s\n' "$image_archive" >&2
  exit 1
fi

load_output=""
if ! load_output="$(docker load --input "$image_archive" 2>&1)"; then
  printf '%s\n' "$load_output" >&2
  exit 1
fi
printf '%s\n' "$load_output"
image="$(
  printf '%s\n' "$load_output" |
    sed -n -e 's/^Loaded image: //p' -e 's/^Loaded image ID: //p' |
    tail -n 1
)"
if [[ -z "$image" ]]; then
  printf 'docker load did not report a loaded image\n' >&2
  exit 1
fi

start_appliance() {
  local data="$1"
  shift
  docker run --detach \
    --name "$container" \
    --stop-timeout 60 \
    --publish 127.0.0.1::8080 \
    --publish 127.0.0.1::8081 \
    --mount "type=volume,source=${data},target=/var/lib/neoseq" \
    --mount "type=volume,source=${backup_volume},target=/backups" \
    "$@" "$image" >/dev/null
  wait_for_health
  assert_roots_and_readiness
}

assert_identity() {
  local expected="$1"
  [[ "$(docker exec "$container" stat -c '%u:%g' \
    /var/lib/neoseq/postgres/data/PG_VERSION)" == "$expected" ]]
  docker exec --env "EXPECTED_ID=$expected" "$container" /bin/sh -eu -c '
    for process in /proc/[0-9]*; do
      read -r name < "$process/comm" || continue
      case "$name" in
        postgres|neoseq-applianc*|neoseq-server|caddy)
          while read -r field real effective saved filesystem; do
            case "$field" in
              Uid:) expected=${EXPECTED_ID%:*} ;;
              Gid:) expected=${EXPECTED_ID#*:} ;;
              *) continue ;;
            esac
            if [ "$real:$effective:$saved:$filesystem" != "$expected:$expected:$expected:$expected" ]; then
              printf "%s has unexpected %s %s %s %s %s\n" "$name" "$field" "$real" "$effective" "$saved" "$filesystem" >&2
              exit 1
            fi
          done < "$process/status"
          ;;
      esac
    done
  '
}

exercise_backup_restore() {
  local uid="$1"
  local gid="$2"
  local backup_path="/backups/smoke-${uid}-${gid}.dump"
  assert_identity "$uid:$gid"
  docker exec "$container" neoseq-appliance backup "$backup_path"
  [[ "$(docker exec "$container" stat -c '%u:%g' "$backup_path")" == "$uid:$gid" ]]

  docker stop "$container" >/dev/null
  local exit_code
  exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container")"
  if [[ "$exit_code" != "0" ]]; then
    printf 'container did not stop cleanly (exit=%s)\n' "$exit_code" >&2
    return 1
  fi

  docker run --rm \
    --name "$restore_container" \
    --env "PUID=$uid" --env "PGID=$gid" \
    --env NEOSEQ_RESTORE_CONFIRM=replace-neoseq-data \
    --mount "type=volume,source=${data_volume},target=/var/lib/neoseq" \
    --mount "type=volume,source=${backup_volume},target=/backups" \
    "$image" restore "$backup_path"

  docker start "$container" >/dev/null
  wait_for_health
  assert_roots_and_readiness
  assert_identity "$uid:$gid"
}

for volume in "$data_volume" "$fresh_data_volume" "$backup_volume"; do
  docker volume create "$volume" >/dev/null
done

# Existing deployments retain the default account and the complete lifecycle.
start_appliance "$data_volume"
exercise_backup_restore 10001 10001
docker stop "$container" >/dev/null
docker rm --force "$container" >/dev/null

# Recreating a container also migrates existing data and backup ownership.
start_appliance "$data_volume" --env PUID=12345 --env PGID=23456
[[ "$(docker exec "$container" stat -c '%u:%g' /backups/smoke-10001-10001.dump)" == '12345:23456' ]]
exercise_backup_restore 12345 23456
docker stop "$container" >/dev/null
docker rm --force "$container" >/dev/null

# A new cluster must initialize with the custom named account as well.
start_appliance "$fresh_data_volume" --env PUID=12345 --env PGID=23456
assert_identity 12345:23456

# Ownership preparation must not follow a symlink outside a managed directory.
docker exec "$container" /bin/sh -eu -c '
  touch /ownership-sentinel
  chown 34567:45678 /ownership-sentinel
  ln -s /ownership-sentinel /backups/outside-link
'
docker restart "$container" >/dev/null
wait_for_health
assert_identity 12345:23456
[[ "$(docker exec "$container" stat -c '%u:%g' /ownership-sentinel)" == '34567:45678' ]]

for setting in PUID=0 PGID=0 PUID=invalid PGID=4294967295; do
  if docker run --rm --name "$restore_container" --env "$setting" "$image" health; then
    printf 'invalid identity was accepted: %s\n' "$setting" >&2
    exit 1
  fi
done

printf 'Neoseq appliance image smoke test passed.\n'
