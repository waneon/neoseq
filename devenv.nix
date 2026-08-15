{
  config,
  pkgs,
  lib,
  ...
}:

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
      exec = ''
        set -euo pipefail

        test_root="$(mktemp -d)"
        cleanup() {
          if [[ -f "$test_root/data/postmaster.pid" ]]; then
            pg_ctl -D "$test_root/data" -m immediate -w stop >/dev/null
          fi
          rm -rf "$test_root"
        }
        trap cleanup EXIT INT TERM

        mkdir -p "$test_root/socket"
        initdb \
          -D "$test_root/data" \
          --auth=trust \
          --encoding=UTF8 \
          --no-locale \
          --username=postgres >/dev/null
        pg_ctl \
          -D "$test_root/data" \
          -o "-F -h ''' -k '$test_root/socket'" \
          -w start >/dev/null

        export DATABASE_URL="postgresql://postgres@localhost/postgres?host=$test_root/socket"
        cargo test -p sync-server --test postgres -- --nocapture
      '';
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

    "web:check" = {
      description = "Check TypeScript";
      exec = "pnpm --filter @neoseq/client exec tsc -b --pretty false";
      after = [
        "coreport:check"
        "i18n:check"
      ];
      before = [ "devenv:enterTest" ];
    };
    "web:test-components" = {
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

  profiles.browser.module = {
    packages = [ pkgs.playwright-driver ];
    env = {
      PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
      FONTCONFIG_FILE = pkgs.makeFontsConf {
        fontDirectories = [ pkgs.dejavu_fonts ];
      };
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
    };
  };
}
