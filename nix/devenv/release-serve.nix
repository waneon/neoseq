{
  config,
  pkgs,
  lib,
  ...
}:

let
  webPort = 4174;
  syncPort = 8788;
  postgresPort = 5433;
  caddyfile = pkgs.writeText "neoseq-release-serve.Caddyfile" ''
    {
    	admin off
    	auto_https off
    	persist_config off
    }

    http://127.0.0.1:${toString webPort} {
    	bind 127.0.0.1

    	handle /v1/* {
    		reverse_proxy 127.0.0.1:${toString syncPort}
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
  packages = lib.mkForce [ ];
  languages.javascript.pnpm.install.enable = false;
  services.postgres.port = lib.mkForce postgresPort;

  processes = {
    web = {
      exec = lib.mkForce "exec ${lib.getExe pkgs.caddy} run --config ${caddyfile} --adapter caddyfile";
      after = lib.mkForce [ "devenv:processes:sync-server@ready" ];
      ready.http.get.port = lib.mkForce webPort;
    };
    sync-server = {
      env = {
        DATABASE_URL = lib.mkForce "postgresql:///neoseq?host=${config.env.PGHOST}&port=${toString postgresPort}";
        NEOSEQ_BIND = "127.0.0.1:${toString syncPort}";
      };
      exec = lib.mkForce "exec ${lib.getExe config.outputs.sync-server} serve";
      ready.http.get.port = lib.mkForce syncPort;
    };
  };
}
