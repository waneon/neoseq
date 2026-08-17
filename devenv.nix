{
  config,
  pkgs,
  lib,
  ...
}:

let
  withTestDatabase = pkgs.writeShellApplication {
    name = "with-test-database";
    runtimeInputs = [
      config.services.postgres.package
      pkgs.coreutils
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
  };
in
{
  languages = {
    rust = {
      enable = true;
      channel = "stable";
      targets = [ "wasm32-unknown-unknown" ];
    };
    javascript = {
      enable = true;
      package = pkgs.nodejs_22;
      pnpm = {
        enable = true;
        package = pkgs.pnpm_10;
        install.enable = true;
      };
    };
  };

  packages = [
    pkgs.cargo-deny
    pkgs.wasm-bindgen-cli
  ];

  env = lib.optionalAttrs pkgs.stdenv.isDarwin {
    LIBRARY_PATH = "${pkgs.libiconv}/lib";
    NIX_LDFLAGS = "-L${pkgs.libiconv}/lib";
  };

  services.postgres = {
    enable = true;
    package = pkgs.postgresql_17;
    initialDatabases = [ { name = "neoseq"; } ];
  };

  processes = {
    web = {
      exec = "pnpm --filter @neoseq/client exec vite";
      after = [ "wasm:build-dev" ];
      ready.http.get = {
        port = 4173;
        path = "/";
      };
      restart.on = "never";
      start.enable = !config.devenv.isTesting;
    };
    sync-server = {
      exec = ''
        DATABASE_URL="postgresql:///neoseq?host=$PGHOST" \
          NEOSEQ_TEST_AUTH_SECRET="neoseq-local-development-only" \
          exec cargo run --locked -p sync-server -- serve
      '';
      after = [ "devenv:processes:postgres" ];
      ready.http.get = {
        port = 8787;
        path = "/readyz";
      };
      restart.on = "never";
      start.enable = !config.devenv.isTesting;
    };
  };

  tasks = {
    "coreport:generate" = {
      description = "Generate CorePort files when stale";
      exec = "node scripts/generate-contracts.mjs";
    };
    "coreport:check" = {
      description = "Check generated CorePort files";
      exec = "node scripts/generate-contracts.mjs --check";
    };
    "i18n:generate" = {
      description = "Generate locale message types when stale";
      exec = "node scripts/generate-i18n.mjs";
    };
    "i18n:check" = {
      description = "Check generated locale message types";
      exec = "node scripts/generate-i18n.mjs --check";
    };

    "rust:fmt" = {
      description = "Check Rust formatting";
      exec = "cargo fmt --all -- --check";
      after = [ "coreport:check" ];
      before = [ "devenv:enterTest" ];
    };
    "rust:clippy" = {
      description = "Lint the Rust workspace";
      exec = "cargo clippy --workspace --all-targets --all-features -- --deny warnings";
      after = [ "coreport:check" ];
      before = [ "devenv:enterTest" ];
    };
    "rust:test" = {
      description = "Test the Rust workspace";
      exec = "cargo test --workspace --all-features";
      after = [ "coreport:check" ];
      before = [ "devenv:enterTest" ];
    };
    "rust:deny" = {
      description = "Check Rust dependency policy";
      exec = "cargo deny --all-features check bans licenses sources";
      after = [ "coreport:check" ];
      before = [ "devenv:enterTest" ];
    };

    "sync-server:test" = {
      description = "Run PostgreSQL migration, persistence, and restore tests";
      exec = "${withTestDatabase}/bin/with-test-database cargo test -p sync-server --test postgres -- --ignored --nocapture";
      after = [ "devenv:processes:postgres@ready" ];
      before = [ "devenv:enterTest" ];
    };

    "wasm:build-dev" = {
      description = "Build development Wasm bindings";
      exec = ''
        set -euo pipefail
        cargo build --release --target wasm32-unknown-unknown -p platform-web
        wasm-bindgen \
          --target web \
          --out-dir apps/client/src/wasm \
          --out-name neoseq_core \
          target/wasm32-unknown-unknown/release/platform_web.wasm
      '';
      after = [ "coreport:check" ];
    };

    "frontend:check" = {
      description = "Check TypeScript";
      exec = "pnpm --filter @neoseq/client exec tsc -b --pretty false";
      after = [
        "coreport:check"
        "i18n:check"
      ];
      before = [ "devenv:enterTest" ];
    };
    "frontend:test" = {
      description = "Run component tests";
      exec = "pnpm --filter @neoseq/client exec vitest run";
      after = [
        "coreport:check"
        "i18n:check"
      ];
      before = [ "devenv:enterTest" ];
    };
  };

  outputs = {
    web = pkgs.callPackage ./nix/web.nix {
      rustToolchain = config.languages.rust.toolchainPackage;
      nodejs = config.languages.javascript.package;
      pnpm = config.languages.javascript.pnpm.package;
    };
    sync-server = pkgs.callPackage ./nix/sync-server.nix {
      rustToolchain = config.languages.rust.toolchainPackage;
    };
  };

  profiles.browser.module = { config, ... }:
  let
    e2eSyncPort = config.processes.e2e-sync-server.ports.http.value;
  in
  {
    packages = [ pkgs.playwright-driver ];
    env = {
      PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
      FONTCONFIG_FILE = pkgs.makeFontsConf {
        fontDirectories = [ pkgs.dejavu_fonts ];
      };
    };
    processes.e2e-sync-server = {
      exec = "${withTestDatabase}/bin/with-test-database cargo run --quiet --locked -p sync-server -- serve";
      env = {
        NEOSEQ_BIND = "127.0.0.1:${toString e2eSyncPort}";
        NEOSEQ_TEST_AUTH_SECRET = "neoseq-browser-collaboration";
      };
      ports.http.allocate = 8787;
      after = [
        "browser:e2e"
        "devenv:processes:postgres@ready"
      ];
      ready = {
        http.get = {
          port = e2eSyncPort;
          path = "/readyz";
        };
        period = 1;
        timeout = 30;
      };
      restart.on = "never";
      # The browser profile also supports interactive shells; only the full
      # test lifecycle should auto-start this isolated service.
      start.enable = config.devenv.isTesting;
    };
    tasks = {
      "web:build-test" = {
        description = "Build the Web client with browser-test routes";
        exec = "pnpm --filter @neoseq/client exec vite build --mode test";
        after = [
          "i18n:check"
          "wasm:build-dev"
        ];
      };
      "browser:indexeddb" = {
        description = "Run IndexedDB persistence contracts";
        exec = "pnpm --filter @neoseq/client exec playwright test tests/persistence.spec.ts --project=chromium";
        after = [ "web:build-test" ];
      };
      "browser:e2e" = {
        description = "Run browser end-to-end tests";
        exec = "pnpm --filter @neoseq/client exec playwright test e2e/";
        after = [ "browser:indexeddb" ];
        before = [ "devenv:enterTest" ];
      };
      "browser:e2e-collaboration" = {
        description = "Run the real two-browser collaboration scenario";
        env.NEOSEQ_SYNC_ORIGIN = "http://127.0.0.1:${toString e2eSyncPort}";
        exec = ''
          set -euo pipefail

          export NEOSEQ_TEST_AUTH_SECRET="neoseq-browser-collaboration"
          export NEOSEQ_E2E_OWNER_TOKEN="$(cargo run --quiet --locked -p sync-server -- issue-token e2e-owner)"
          export NEOSEQ_E2E_PEER_TOKEN="$(cargo run --quiet --locked -p sync-server -- issue-token e2e-peer)"
          pnpm --filter @neoseq/client exec playwright test \
            tests/e2e/collaboration.spec.ts \
            --project=chromium
        '';
        after = [ "devenv:processes:e2e-sync-server@ready" ];
        before = [ "devenv:enterTest" ];
      };
    };
  };
}
