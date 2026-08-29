{ config, pkgs, ... }:

let
  client = "pnpm --filter @neoseq/client exec";
  syncPort = config.processes.e2e-sync-server.ports.http.value;
  previewPort = config.processes.e2e-web.ports.http.value;
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
    e2e-sync-server = {
      exec = "with-test-database cargo run --quiet --locked -p sync-server";
      env = {
        NEOSEQ_BIND = "127.0.0.1:${toString syncPort}";
        NEOSEQ_BOOTSTRAP_ADMIN_USERNAME = "e2e-admin";
        NEOSEQ_BOOTSTRAP_ADMIN_PASSWORD = adminPassword;
      };
      ports.http.allocate = 8787;
      after = [ "devenv:processes:postgres" ];
      ready.http.get = {
        port = syncPort;
        path = "/readyz";
      };
      ready.timeout = 30;
      restart.on = "never";
      start.enable = config.devenv.isTesting;
    };

    e2e-web = {
      exec = "${client} vite preview --host 127.0.0.1 --port ${toString previewPort}";
      env.NEOSEQ_SYNC_ORIGIN = "http://127.0.0.1:${toString syncPort}";
      ports.http.allocate = 4173;
      after = [ "web:build-test" ];
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
    "web:build-test" = {
      description = "Build the Web client with browser test routes";
      exec = "${client} vite build --mode test";
      after = [
        "i18n:check"
        "wasm:build-dev"
      ];
    };

    "browser:test" = {
      description = "Run browser end-to-end tests";
      exec = ''
        set -euo pipefail
        export NEOSEQ_E2E_SYNC_ORIGIN="http://127.0.0.1:${toString syncPort}"
        export NEOSEQ_E2E_ADMIN_PASSWORD="${adminPassword}"
        export NEOSEQ_E2E_OWNER_PASSWORD="${ownerPassword}"
        export NEOSEQ_E2E_PEER_PASSWORD="${peerPassword}"
        export NEOSEQ_PREVIEW_PORT="${toString previewPort}"
        export NEOSEQ_E2E_MANAGED_PREVIEW=1
        ${client} playwright test
      '';
      after = [
        "frontend:test"
        "devenv:processes:e2e-sync-server"
        "devenv:processes:e2e-web"
      ];
    };

    "devenv:enterTest".after = [ "browser:test" ];
  };
}
