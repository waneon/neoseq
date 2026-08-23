{ config, lib, ... }:

let
  client = "pnpm --filter @neoseq/client exec";
  databaseTest = "with-test-database cargo test -p sync-server --test postgres -- --ignored --nocapture";
  portable = config.neoseq.verification == "portable";
in
{
  options.neoseq.verification = lib.mkOption {
    type = lib.types.enum [
      "portable"
      "browser"
    ];
    default = "portable";
    description = "Verification gate run by devenv test";
  };

  config = lib.mkMerge [
    {
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

        "sync-server:test" = {
          description = "Run PostgreSQL migration, persistence, and restore tests";
          exec = databaseTest;
          after = lib.optional (!config.devenv.isTesting) "devenv:processes:postgres";
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
      };
    }
    (lib.mkIf portable {
      # Devenv starts managed processes after task-backed checks and before enterTest.
      enterTest = lib.mkAfter databaseTest;
      tasks."devenv:enterTest".after = [
        "frontend:check"
        "frontend:test"
        "nix:hash-check"
        "rust:clippy"
        "rust:deny"
        "rust:fmt"
        "rust:test"
      ];
    })
  ];
}
