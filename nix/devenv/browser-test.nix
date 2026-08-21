{
  config,
  lib,
  pkgs,
  ...
}:

let
  authSecret = "neoseq-browser-collaboration";
  client = "pnpm --filter @neoseq/client exec";
  syncPort = config.processes.e2e-sync-server.ports.http.value;
  buildWeb = "${client} vite build --mode test";
  testIndexedDb = "${client} playwright test tests/persistence.spec.ts --project=chromium";
  testE2e = "${client} playwright test e2e/";
  testCollaboration = ''
    set -euo pipefail
    export NEOSEQ_E2E_OWNER_TOKEN="$(cargo run --quiet --locked -p sync-server -- issue-token e2e-owner)"
    export NEOSEQ_E2E_PEER_TOKEN="$(cargo run --quiet --locked -p sync-server -- issue-token e2e-peer)"
    ${client} playwright test \
      tests/e2e/collaboration.spec.ts \
      --project=chromium
  '';
  browserTest = ''
    ${buildWeb}
    ${testIndexedDb}
    ${testE2e}
    export NEOSEQ_SYNC_ORIGIN="http://127.0.0.1:${toString syncPort}"
    export NEOSEQ_TEST_AUTH_SECRET="${authSecret}"
    ${testCollaboration}
  '';
in
{
  enterTest = lib.mkAfter browserTest;

  packages = [ pkgs.playwright-driver ];
  env = {
    PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
    FONTCONFIG_FILE = pkgs.makeFontsConf {
      fontDirectories = [ pkgs.dejavu_fonts ];
    };
  };

  processes.e2e-sync-server = {
    exec = "with-test-database cargo run --quiet --locked -p sync-server -- serve";
    env = {
      NEOSEQ_BIND = "127.0.0.1:${toString syncPort}";
      NEOSEQ_TEST_AUTH_SECRET = authSecret;
    };
    ports.http.allocate = 18787;
    after = [ "devenv:processes:postgres" ];
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
      exec = buildWeb;
      after = [
        "i18n:check"
        "wasm:build-dev"
      ];
    };
    "browser:indexeddb" = {
      description = "Run IndexedDB persistence contracts";
      exec = testIndexedDb;
      after = [ "web:build-test" ];
    };
    "browser:e2e" = {
      description = "Run browser end-to-end tests";
      exec = testE2e;
      after = [ "browser:indexeddb" ];
    };
    "browser:e2e-collaboration" = {
      description = "Run the real two-browser collaboration scenario";
      env = {
        NEOSEQ_SYNC_ORIGIN = "http://127.0.0.1:${toString syncPort}";
        NEOSEQ_TEST_AUTH_SECRET = authSecret;
      };
      exec = testCollaboration;
      after = [
        "browser:e2e"
      ]
      ++ lib.optional (!config.devenv.isTesting) "devenv:processes:e2e-sync-server";
    };
  };
}
