#!/usr/bin/env bash
# Verifies only what the changes since a base revision (default: main) can
# affect; a path it cannot classify selects every tier. This is the inner loop:
# `devenv test` and CI remain the complete gate.
set -euo pipefail

cd "${DEVENV_ROOT:?run inside the devenv shell}"
fork="$(git merge-base HEAD "${1:-main}")"
tracked="$(git diff --name-only "$fork")"
untracked="$(git ls-files --others --exclude-standard)"
mapfile -t changed < <(printf '%s\n' "$tracked" "$untracked" | sed '/^$/d' | sort -u)

declare -A tasks=()
present=()
client=()
dashboard=()
specs=()
support=false
want() { for task; do tasks["$task"]=1; done; }

for path in "${changed[@]}"; do
  [[ -e "$path" ]] && present+=("$path")
  case "$path" in
  *.md) ;;
  crates/neoseq-server/* | crates/neoseq-appliance/* | crates/benchmarks/*)
    want rust:clippy gate:rust
    ;;
  crates/* | Cargo.toml)
    # Every other crate reaches the client through its Wasm core.
    want rust:clippy gate:rust gate:component
    ;;
  Cargo.lock | deny.toml)
    want rust:deny nix:hash-check gate:rust gate:component
    ;;
  pnpm-lock.yaml | package.json | apps/*/package.json)
    want node:licenses nix:hash-check frontend:check gate:component
    ;;
  apps/client/tests/e2e/*.spec.ts | apps/client/tests/contracts/*.spec.ts)
    want browser:check
    [[ -e "$path" ]] && specs+=("${path#apps/client/}")
    ;;
  apps/client/src/* | apps/client/tests/component/*)
    want frontend:check
    [[ -e "$path" ]] && client+=("$PWD/$path")
    ;;
  apps/client/tests/* | apps/client/playwright.config.ts | apps/client/tsconfig.browser.json)
    want browser:check
    support=true
    ;;
  apps/dashboard/src/* | apps/dashboard/tests/*)
    want frontend:check
    [[ -e "$path" ]] && dashboard+=("$PWD/$path")
    ;;
  *)
    echo "verify-changed: $path selects every tier"
    want gate:check gate:rust gate:component
    ;;
  esac
done

((${#present[@]} > 0)) && treefmt --ci "${present[@]}"
((${#tasks[@]} > 0)) && devenv tasks run "${!tasks[@]}"
# The component tier, when selected, already ran every suite.
if [[ -z "${tasks["gate:component"]:-}" ]]; then
  ((${#client[@]} > 0)) && pnpm --filter @neoseq/client exec vitest related --run "${client[@]}"
  ((${#dashboard[@]} > 0)) && pnpm --filter @neoseq/dashboard exec vitest related --run "${dashboard[@]}"
fi
((${#specs[@]} > 0)) &&
  devenv --profile browser shell -- pnpm --filter @neoseq/client exec playwright test "${specs[@]}"
if $support; then
  echo "verify-changed: browser support changed; run the journeys it serves:" \
    "devenv --profile browser shell -- pnpm --filter @neoseq/client exec playwright test [filters]"
fi
echo "verify-changed: passed"
