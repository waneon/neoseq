{
  config,
  pkgs,
  lib,
  ...
}:

let
  caddyfile = pkgs.writeText "neoseq-release-serve.Caddyfile" ''
    {
	admin off
	auto_https off
	persist_config off
    }

    http://127.0.0.1:4173 {
	bind 127.0.0.1

	handle /v1/* {
		reverse_proxy 127.0.0.1:8787
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

  processes = {
    web = {
      exec = lib.mkForce "exec ${lib.getExe pkgs.caddy} run --config ${caddyfile} --adapter caddyfile";
      after = lib.mkForce [ "devenv:processes:sync-server@ready" ];
    };
    sync-server.exec = lib.mkForce "exec ${lib.getExe config.outputs.sync-server} serve";
  };
}
