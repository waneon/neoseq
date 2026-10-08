{ config, pkgs, ... }:

let
  client = "pnpm --filter @neoseq/client exec";
in
{
  # The profile supplies tools only. Playwright owns the run: it builds fresh
  # artifacts, serves them, and starts a synchronization server on a throwaway
  # PostgreSQL cluster, all on ports it chooses per run.
  packages = [
    pkgs.playwright-driver
    config.services.postgres.package
  ];
  env = {
    PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
    FONTCONFIG_FILE = pkgs.makeFontsConf { fontDirectories = [ pkgs.dejavu_fonts ]; };
  };

  tasks = {
    "browser:test" = {
      description = "Run Playwright journeys and browser contracts";
      exec = "${client} playwright test";
      after = [
        "browser:check"
        "i18n:check"
        "wasm:build-dev"
      ];
    };

    "gate:browser" = {
      description = "Browser tier: Playwright journeys and browser contracts";
      after = [ "browser:test" ];
    };

    "devenv:enterTest".after = [ "gate:browser" ];
  };
}
