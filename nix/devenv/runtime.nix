{
  config,
  lib,
  pkgs,
  ...
}:

let
  release = config.neoseq.runtime == "release";
  ports =
    if release then
      {
        web = 4174;
        sync = 8788;
        postgres = 5433;
      }
    else
      {
        web = config.processes.web.ports.http.value;
        sync = config.processes.sync-server.ports.http.value;
        postgres = config.processes.postgres.ports.main.value;
      };
  databaseUrl = "postgresql:///neoseq?host=${config.env.PGHOST}&port=${toString ports.postgres}";
  caddyfile = pkgs.writeText "neoseq.Caddyfile" ''
    {
      admin off
      auto_https off
      persist_config off
    }

    http://127.0.0.1:${toString ports.web} {
      bind 127.0.0.1

      handle /v1/* {
        reverse_proxy 127.0.0.1:${toString ports.sync}
      }

      handle {
        root * ${config.outputs.web}
        try_files {path} /index.html
        file_server
      }
    }
  '';
in
{
  options.neoseq.runtime = lib.mkOption {
    type = lib.types.enum [
      "development"
      "release"
    ];
    default = "development";
    description = "Neoseq process runtime to expose";
  };

  config = {
    packages = lib.optionals (!release) [
      pkgs.cargo-deny
      pkgs.wasm-bindgen-cli
    ];

    languages.javascript.pnpm.install.enable = !release;
    services.postgres.port = ports.postgres;

    processes = {
      postgres = lib.mkIf (!release) {
        ports.main.allocate = 5432;
      };

      web = {
        ports = lib.mkIf (!release) {
          http.allocate = 4173;
        };
        env = lib.optionalAttrs (!release) {
          NEOSEQ_SYNC_ORIGIN = "http://127.0.0.1:${toString ports.sync}";
        };
        exec =
          if release then
            "exec ${lib.getExe pkgs.caddy} run --config ${caddyfile} --adapter caddyfile"
          else
            "exec pnpm --filter @neoseq/client exec vite --port ${toString ports.web}";
        after = if release then [ "devenv:processes:sync-server" ] else [ "wasm:build-dev" ];
        ready.http.get = {
          port = ports.web;
          path = "/";
        };
        restart.on = "never";
        start.enable = !config.devenv.isTesting;
      };

      sync-server = {
        ports = lib.mkIf (!release) {
          http.allocate = 8787;
        };
        env = {
          DATABASE_URL = databaseUrl;
          NEOSEQ_BIND = "127.0.0.1:${toString ports.sync}";
          NEOSEQ_TEST_AUTH_SECRET = "neoseq-local-development-only";
        };
        exec =
          if release then
            "exec ${lib.getExe config.outputs.sync-server} serve"
          else
            "exec cargo run --locked -p sync-server -- serve";
        after = [ "devenv:processes:postgres" ];
        ready.http.get = {
          port = ports.sync;
          path = "/readyz";
        };
        restart.on = "never";
        start.enable = !config.devenv.isTesting;
      };
    };
  };
}
