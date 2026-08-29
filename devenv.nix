{ config, pkgs, ... }:

let
  client = "pnpm --filter @neoseq/client exec";
  ports = {
    web = config.processes.web.ports.http.value;
    sync = config.processes.sync-server.ports.http.value;
  };
  databaseUrl = "postgresql:///neoseq?host=${config.env.PGHOST}&port=${toString config.env.PGPORT}";
  databaseTest = "with-test-database cargo test -p sync-server --test postgres -- --ignored --nocapture";
  mkSource = pkgs.callPackage ./nix/libs/mk-source.nix { };
in
{
  packages = [
    pkgs.cargo-deny
    pkgs.wasm-bindgen-cli
  ];

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

  services.postgres = {
    enable = true;
    package = pkgs.postgresql_17;
    initialDatabases = [ { name = "neoseq"; } ];
  };

  processes = {
    web = {
      ports.http.allocate = 4173;
      env.NEOSEQ_SYNC_ORIGIN = "http://127.0.0.1:${toString ports.sync}";
      exec = "exec pnpm --filter @neoseq/client exec vite --port ${toString ports.web}";
      after = [ "wasm:build-dev" ];
      ready.http.get = {
        port = ports.web;
        path = "/";
      };
      restart.on = "never";
      start.enable = !config.devenv.isTesting;
    };

    sync-server = {
      ports.http.allocate = 8787;
      env = {
        DATABASE_URL = databaseUrl;
        NEOSEQ_BIND = "127.0.0.1:${toString ports.sync}";
        NEOSEQ_TEST_AUTH_SECRET = "neoseq-local-development-only";
      };
      exec = "exec cargo run --locked -p sync-server -- serve";
      after = [ "devenv:processes:postgres" ];
      ready.http.get = {
        port = ports.sync;
        path = "/readyz";
      };
      restart.on = "never";
      start.enable = !config.devenv.isTesting;
    };
  };

  scripts.with-test-database = {
    description = "Run a command in an isolated temporary PostgreSQL database";
    exec = ./scripts/with-test-database.sh;
    packages = [
      config.services.postgres.package
      pkgs.coreutils
    ];
  };

  tasks = {
    "contracts:generate" = {
      description = "Generate contract files when stale";
      exec = "node scripts/generate-contracts.mjs";
    };
    "contracts:check" = {
      description = "Check generated contract files";
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
      after = [ "contracts:check" ];
    };

    "rust:fmt" = {
      description = "Check Rust formatting";
      exec = "cargo fmt --all -- --check";
      after = [ "contracts:check" ];
    };
    "rust:clippy" = {
      description = "Lint the Rust workspace";
      exec = "cargo clippy --workspace --all-targets --all-features -- --deny warnings";
      after = [ "contracts:check" ];
    };
    "rust:test" = {
      description = "Test the Rust workspace";
      exec = "cargo test --workspace --all-features";
      after = [ "contracts:check" ];
    };
    "rust:deny" = {
      description = "Check Rust dependency policy";
      exec = "cargo deny --all-features check bans licenses sources";
      after = [ "contracts:check" ];
    };

    "node:licenses" = {
      description = "Check Node dependency licenses";
      exec = "node scripts/check-node-licenses.mjs";
    };

    "sync-server:postgres-test" = {
      description = "Run PostgreSQL migration, persistence, and restore tests";
      exec = databaseTest;
      after = [ "devenv:processes:postgres" ];
    };

    "frontend:check" = {
      description = "Check TypeScript";
      exec = "${client} tsc -b --pretty false";
      after = [
        "contracts:check"
        "i18n:check"
        "wasm:build-dev"
      ];
    };
    "frontend:test" = {
      description = "Run component tests";
      exec = "${client} vitest run";
      after = [
        "contracts:check"
        "i18n:check"
      ];
    };

    "nix:hash-check" = {
      description = "Check fixed-output dependency hashes";
      exec = ''
        devenv build \
          outputs.web.cargoDeps \
          outputs.web.pnpmDeps \
          outputs.sync-server.cargoDeps
      '';
    };

    "devenv:enterTest".after = [
      "frontend:check"
      "frontend:test"
      "nix:hash-check"
      "node:licenses"
      "rust:clippy"
      "rust:deny"
      "rust:fmt"
      "rust:test"
      "sync-server:postgres-test"
    ];
  };

  outputs = {
    web = pkgs.callPackage ./nix/outputs/web.nix {
      inherit mkSource;
      rustToolchain = config.languages.rust.toolchainPackage;
      nodejs = config.languages.javascript.package;
      pnpm = config.languages.javascript.pnpm.package;
    };
    sync-server = pkgs.callPackage ./nix/outputs/sync-server.nix {
      inherit mkSource;
      rustToolchain = config.languages.rust.toolchainPackage;
    };
  };

  profiles.browser.module = ./nix/profiles/browser.nix;
}
