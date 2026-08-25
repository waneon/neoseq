{
  config,
  pkgs,
  ...
}:

let
  client = "pnpm --filter @neoseq/client exec";
  syncPort = config.processes.e2e-sync-server.ports.http.value;
  previewPort = config.processes.e2e-sync-server.ports.preview.value;
in
{
  neoseq.verification = "browser";

  enterTest = ''
    set -euo pipefail
    export NEOSEQ_E2E_OWNER_TOKEN="$(cargo run --quiet --locked -p sync-server -- issue-token e2e-owner)"
    export NEOSEQ_E2E_PEER_TOKEN="$(cargo run --quiet --locked -p sync-server -- issue-token e2e-peer)"
    if [[ -z "''${NEOSEQ_PREVIEW_PORT:-}" ]]; then
      export NEOSEQ_PREVIEW_PORT="${toString previewPort}"
    fi
    # web:build-test is an enterTest prerequisite; tell Playwright not to build
    # the same artifact again. Direct Playwright runs do not inherit this marker.
    export NEOSEQ_E2E_PREBUILT=1
    ${client} playwright test
  '';

  packages = [ pkgs.playwright-driver ];
  env = {
    PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
    FONTCONFIG_FILE = pkgs.makeFontsConf {
      fontDirectories = [ pkgs.dejavu_fonts ];
    };
    NEOSEQ_SYNC_ORIGIN = "http://127.0.0.1:${toString syncPort}";
    NEOSEQ_TEST_AUTH_SECRET = "neoseq-browser-collaboration";
  };

  processes.e2e-sync-server = {
    exec = "with-test-database cargo run --quiet --locked -p sync-server -- serve";
    env.NEOSEQ_BIND = "127.0.0.1:${toString syncPort}";
    # Playwright owns the preview process; the browser profile only allocates its port.
    ports = {
      http.allocate = 18787;
      preview.allocate = 14173;
    };
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
      description = "Build the Web client with browser test routes";
      exec = "${client} vite build --mode test";
      after = [
        "i18n:check"
        "wasm:build-dev"
      ];
    };

    "devenv:enterTest".after = [ "web:build-test" ];
  };
}
