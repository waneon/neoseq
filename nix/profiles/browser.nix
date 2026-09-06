{ config, pkgs, ... }:

let
  client = "pnpm --filter @neoseq/client exec";
  syncPort = config.processes.e2e-neoseq-server.ports.http.value;
  previewPort = config.processes.e2e-neoseq-client.ports.http.value;
  adminPassword = "browser admin password";
  ownerPassword = "browser owner password";
  peerPassword = "browser peer password";
in
{
  packages = [ pkgs.playwright-driver ];
  env = {
    PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
    FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
  };

  processes = {
    e2e-neoseq-server = {
      exec = "exec with-test-database ./target/debug/neoseq-server";
      env = {
        NEOSEQ_BIND = "127.0.0.1:${toString syncPort}";
        NEOSEQ_BOOTSTRAP_ADMIN_USERNAME = "e2e-admin";
        NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD = adminPassword;
      };
      ports.http.allocate = 8787;
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
      exec = "${client} vite preview --host 127.0.0.1 --port ${toString previewPort}";
      env.NEOSEQ_SYNC_ORIGIN = "http://127.0.0.1:${toString syncPort}";
      ports.http.allocate = 4173;
      after = [ "neoseq-client:build-test" ];
      ready.http.get = {
        port = previewPort;
        path = "/";
      };
      ready.timeout = 30;
      restart.on = "never";
      start.enable = config.devenv.isTesting;
    };
  };

  tasks = {
    "neoseq-server:build-test" = {
      description = "Build the browser collaboration server before its readiness deadline";
      exec = "cargo build --locked -p neoseq-server";
      after = [ "contracts:check" ];
    };

    "neoseq-client:build-test" = {
      description = "Build the Web client with browser test routes";
      exec = "${client} vite build --mode test";
      after = [
        "i18n:check"
        "wasm:build-dev"
      ];
    };

    "devenv:enterTest".after = [
      "neoseq-server:build-test"
      "neoseq-client:build-test"
    ];
  };

  # enterTest runs after devenv releases port reservations and starts processes.
  # A task attached to devenv:enterTest runs before that lifecycle boundary.
  enterTest = ''
    set -euo pipefail
    export NEOSEQ_E2E_SYNC_ORIGIN="http://127.0.0.1:${toString syncPort}"
    export NEOSEQ_E2E_ADMIN_PASSWORD="${adminPassword}"
    export NEOSEQ_E2E_OWNER_PASSWORD="${ownerPassword}"
    export NEOSEQ_E2E_PEER_PASSWORD="${peerPassword}"
    export NEOSEQ_PREVIEW_PORT="${toString previewPort}"
    export NEOSEQ_E2E_MANAGED_PREVIEW=1
    ${client} playwright test
  '';
}
