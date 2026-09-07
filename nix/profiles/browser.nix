{ config, pkgs, ... }:

let
  client = "pnpm --filter @neoseq/client exec";
  syncPort = config.processes.e2e-neoseq-server.ports.http.value;
  previewPort = config.processes.e2e-neoseq-client.ports.http.value;
  contractPort = config.processes.e2e-neoseq-contracts.ports.http.value;
  adminPassword = "browser admin password";
in
{
  packages = [ pkgs.playwright-driver ];
  env = {
    PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
    FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
    NEOSEQ_E2E_SYNC_ORIGIN = "http://127.0.0.1:${toString syncPort}";
    NEOSEQ_E2E_ADMIN_PASSWORD = adminPassword;
    NEOSEQ_PREVIEW_PORT = toString previewPort;
    NEOSEQ_CONTRACT_PORT = toString contractPort;
  };

  processes = {
    e2e-neoseq-server = {
      exec = "exec with-test-database ./target/debug/neoseq-server";
      env = {
        NEOSEQ_BIND = "127.0.0.1:${toString syncPort}";
        NEOSEQ_BOOTSTRAP_ADMIN_USERNAME = "e2e-admin";
        NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD = adminPassword;
      };
      ports.http.allocate = 18787;
      after = [
        "devenv:processes:postgres"
        "neoseq-server:build-test"
      ];
      ready.http.get = {
        port = syncPort;
        path = "/readyz";
      };
      ready.timeout = 30;
      restart.on = "never";
      start.enable = config.devenv.isTesting;
    };

    e2e-neoseq-client = {
      exec = "${client} vite preview --host 127.0.0.1 --port ${toString previewPort} --strictPort";
      env.NEOSEQ_SYNC_ORIGIN = "http://127.0.0.1:${toString syncPort}";
      ports.http.allocate = 14173;
      after = [ "neoseq-client:build-test" ];
      ready.http.get = {
        port = previewPort;
        path = "/";
      };
      ready.timeout = 30;
      restart.on = "never";
      start.enable = config.devenv.isTesting;
    };

    e2e-neoseq-contracts = {
      exec = "${client} vite preview --outDir dist-contracts --host 127.0.0.1 --port ${toString contractPort} --strictPort";
      ports.http.allocate = 14174;
      after = [ "neoseq-client:build-contracts" ];
      ready.http.get = {
        port = contractPort;
        path = "/";
      };
      ready.timeout = 30;
      restart.on = "never";
      start.enable = config.devenv.isTesting;
    };
  };

  tasks = {
    "browser:check" = {
      description = "Check browser test fixtures and scenarios";
      exec = "${client} tsc -p tsconfig.browser.json --pretty false";
      after = [ "wasm:build-dev" ];
    };

    "neoseq-server:build-test" = {
      description = "Build the browser collaboration server before its readiness deadline";
      exec = "cargo build --locked -p neoseq-server";
      after = [ "contracts:check" ];
    };

    "neoseq-client:build-test" = {
      description = "Build the production Web client for browser journeys";
      exec = "${client} vite build";
      after = [
        "i18n:check"
        "wasm:build-dev"
      ];
    };

    "neoseq-client:build-contracts" = {
      description = "Build isolated browser adapter and fault contracts";
      exec = "${client} vite build --mode test --outDir dist-contracts";
      after = [
        "i18n:check"
        "wasm:build-dev"
      ];
    };

    "devenv:enterTest".after = [
      "browser:check"
      "neoseq-server:build-test"
      "neoseq-client:build-test"
      "neoseq-client:build-contracts"
    ];
  };

  # enterTest runs after devenv releases port reservations and starts processes.
  # A task attached to devenv:enterTest runs before that lifecycle boundary.
  enterTest = ''
    set -euo pipefail
    export NEOSEQ_E2E_MANAGED_PREVIEW=1
    ${client} playwright test
  '';
}
