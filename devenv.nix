{
  config,
  lib,
  pkgs,
  ...
}:

let
  client = "pnpm --filter @neoseq/client exec";
  dashboard = "pnpm --filter @neoseq/dashboard exec";
  ports = {
    client = config.processes.neoseq-client.ports.http.value;
    dashboard = config.processes.neoseq-dashboard.ports.http.value;
    server = config.processes.neoseq-server.ports.http.value;
  };
  databaseUrl = "postgresql:///neoseq?host=${config.env.PGHOST}&port=${toString config.env.PGPORT}";
  databaseTest = "with-test-database cargo test -p neoseq-server --test postgres -- --ignored --nocapture";
  # The bindgen CLI must match the `wasm-bindgen` version in Cargo.lock exactly.
  wasmBindgen = pkgs.wasm-bindgen-cli_0_2_121;
  mkSource = pkgs.callPackage ./nix/libs/mk-source.nix { };
  dashboardOutput = pkgs.callPackage ./nix/outputs/neoseq-dashboard.nix {
    inherit mkSource;
    nodejs = config.languages.javascript.package;
    pnpm = config.languages.javascript.pnpm.package;
  };
  clientOutput = pkgs.callPackage ./nix/outputs/neoseq-client.nix {
    inherit mkSource;
    wasm-bindgen-cli = wasmBindgen;
    rustToolchain = config.languages.rust.toolchainPackage;
    nodejs = config.languages.javascript.package;
    pnpm = config.languages.javascript.pnpm.package;
  };
  serverOutput = pkgs.callPackage ./nix/outputs/neoseq-server.nix {
    inherit mkSource;
    rustToolchain = config.languages.rust.toolchainPackage;
  };
  dockerOutput =
    if pkgs.stdenv.hostPlatform.isLinux then
      pkgs.callPackage ./nix/outputs/neoseq-docker.nix {
        client = clientOutput;
        dashboard = dashboardOutput;
        server = serverOutput;
      }
    else
      pkgs.runCommand "neoseq-docker-linux-only" { } ''
        echo 'outputs.neoseq-docker requires a Linux builder' >&2
        exit 1
      '';
in
{
  packages = [
    pkgs.cargo-deny
    wasmBindgen
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

  treefmt = {
    enable = true;
    config.programs = {
      nixfmt = {
        enable = true;
        strict = true;
        width = 100;
      };
      prettier = {
        enable = true;
        includes = [
          "*.cjs"
          "*.css"
          "*.html"
          "*.js"
          "*.json"
          "*.json5"
          "*.jsx"
          "*.md"
          "*.mdx"
          "*.mjs"
          "*.scss"
          "*.ts"
          "*.tsx"
          "*.vue"
          "*.yaml"
          "*.yml"
        ];
        excludes = [
          "apps/dashboard/src/i18n/generated/**"
          "apps/client/src/generated/**"
          "apps/client/src/i18n/generated/**"
          "pnpm-lock.yaml"
        ];
        settings = {
          endOfLine = "lf";
          printWidth = 100;
          proseWrap = "preserve";
        };
      };
      rustfmt = {
        enable = true;
        edition = "2024";
        package = config.languages.rust.toolchainPackage;
        excludes = [
          "crates/domain/src/generated/**"
          "crates/sync-protocol/src/generated/**"
        ];
      };
      shfmt = {
        enable = true;
        indent_size = 2;
        simplify = false;
      };
      taplo.enable = true;
    };
  };

  services.postgres = {
    enable = true;
    package = pkgs.postgresql_17;
    initialDatabases = [ { name = "neoseq"; } ];
  };

  processes = {
    neoseq-dashboard = {
      ports.http.allocate = 4174;
      env.NEOSEQ_SYNC_ORIGIN = "http://127.0.0.1:${toString ports.server}";
      exec = "exec pnpm --filter @neoseq/dashboard exec vite --port ${toString ports.dashboard} --strictPort";
      ready.http.get = {
        port = ports.dashboard;
        path = "/";
      };
      restart.on = "never";
      start.enable = !config.devenv.isTesting;
    };

    neoseq-client = {
      ports.http.allocate = 4173;
      env.NEOSEQ_SYNC_ORIGIN = "http://127.0.0.1:${toString ports.server}";
      exec = "exec pnpm --filter @neoseq/client exec vite --port ${toString ports.client} --strictPort";
      after = [ "wasm:build-dev" ];
      ready.http.get = {
        port = ports.client;
        path = "/";
      };
      restart.on = "never";
      start.enable = !config.devenv.isTesting;
    };

    neoseq-server = {
      ports.http.allocate = 8787;
      env = {
        DATABASE_URL = databaseUrl;
        NEOSEQ_BIND = "127.0.0.1:${toString ports.server}";
        NEOSEQ_BOOTSTRAP_ADMIN_USERNAME = "admin";
        NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD = "change-me-later";
      };
      exec = "exec cargo run --locked -p neoseq-server";
      after = [ "devenv:processes:postgres" ];
      ready.http.get = {
        port = ports.server;
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

  scripts.publish-docker = {
    description = "Build and push the amd64 appliance to waneon/neoseq with version and latest tags";
    exec = ./scripts/publish-docker.sh;
    packages = [
      pkgs.docker-client
      pkgs.gnutar
      pkgs.jq
    ];
  };

  tasks = {
    "devenv:treefmt:run".before = lib.mkForce [ ];

    "format:check" = {
      description = "Check repository formatting";
      exec = "treefmt --ci";
    };

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
      exec = "scripts/build-wasm-dev.sh";
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

    "neoseq-server:postgres-test" = {
      description = "Run PostgreSQL schema, persistence, and authorization tests";
      exec = databaseTest;
      after = [ "devenv:processes:postgres" ];
    };

    "frontend:check" = {
      description = "Check TypeScript";
      exec = ''
        ${client} tsc -b --pretty false
        ${dashboard} tsc -p tsconfig.json --pretty false
      '';
      after = [
        "contracts:check"
        "i18n:check"
        "wasm:build-dev"
      ];
    };
    "browser:check" = {
      description = "Check browser test fixtures and scenarios";
      exec = "${client} tsc -p tsconfig.browser.json --pretty false";
      after = [ "wasm:build-dev" ];
    };
    "frontend:test" = {
      description = "Run component tests";
      exec = ''
        ${client} vitest run
        ${dashboard} vitest run
      '';
      after = [
        "contracts:check"
        "i18n:check"
        "wasm:build-dev"
      ];
    };

    "nix:hash-check" = {
      description = "Check fixed-output dependency hashes";
      exec = ''
          devenv build \
        outputs.neoseq-client.cargoDeps \
        outputs.neoseq-client.pnpmDeps \
        outputs.neoseq-dashboard.pnpmDeps \
        outputs.neoseq-server.cargoDeps
      '';
    };

    # Verification tiers. Each runs alone (`devenv tasks run gate:<tier>`) and as
    # its own CI job; `devenv test` runs them all. The browser profile adds
    # `gate:browser`.
    "gate:check" = {
      description = "Static tier: formatting, generated files, types, lints, and dependency policy";
      after = [
        "browser:check"
        "contracts:check"
        "format:check"
        "frontend:check"
        "i18n:check"
        "nix:hash-check"
        "node:licenses"
        "rust:clippy"
        "rust:deny"
      ];
    };
    "gate:rust" = {
      description = "Rust tier: workspace and PostgreSQL integration tests";
      after = [
        "neoseq-server:postgres-test"
        "rust:test"
      ];
    };
    "gate:component" = {
      description = "Component tier: client and dashboard component tests";
      after = [ "frontend:test" ];
    };

    "devenv:enterTest".after = [
      "gate:check"
      "gate:component"
      "gate:rust"
    ];
  };

  outputs = {
    neoseq-dashboard = dashboardOutput;
    neoseq-client = clientOutput;
    neoseq-server = serverOutput;
    neoseq-docker = dockerOutput;
  };

  profiles.browser.module = ./nix/profiles/browser.nix;
}
