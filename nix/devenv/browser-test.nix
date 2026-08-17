{ withTestDatabase }:

{ config, pkgs, ... }:

let
  syncPort = config.processes.e2e-sync-server.ports.http.value;
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
      NEOSEQ_BIND = "127.0.0.1:${toString syncPort}";
      NEOSEQ_TEST_AUTH_SECRET = "neoseq-browser-collaboration";
    };
    ports.http.allocate = 18787;
    after = [ "devenv:processes:postgres@ready" ];
    ready.http.get = {
      port = syncPort;
      path = "/readyz";
    };
    ready.timeout = 30;
    restart.on = "never";
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
    };
    "browser:e2e-collaboration" = {
      description = "Run the real two-browser collaboration scenario";
      env.NEOSEQ_SYNC_ORIGIN = "http://127.0.0.1:${toString syncPort}";
      exec = ''
        set -euo pipefail

        export NEOSEQ_TEST_AUTH_SECRET="neoseq-browser-collaboration"
        export NEOSEQ_E2E_OWNER_TOKEN="$(cargo run --quiet --locked -p sync-server -- issue-token e2e-owner)"
        export NEOSEQ_E2E_PEER_TOKEN="$(cargo run --quiet --locked -p sync-server -- issue-token e2e-peer)"
        pnpm --filter @neoseq/client exec playwright test \
          tests/e2e/collaboration.spec.ts \
          --project=chromium
      '';
      after = [
        "browser:e2e"
        "devenv:processes:e2e-sync-server@ready"
      ];
    };
  };
}
