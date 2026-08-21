{ config, pkgs, ... }:

let
  mkSource = pkgs.callPackage ./nix/mk-source.nix { };
in
{
  imports = [
    ./nix/devenv/runtime.nix
    ./nix/devenv/verification.nix
  ];

  languages = {
    rust = {
      enable = true;
      channel = "stable";
      targets = [ "wasm32-unknown-unknown" ];
    };
    javascript = {
      enable = true;
      package = pkgs.nodejs_22;
      pnpm = {
        enable = true;
        package = pkgs.pnpm_10;
      };
    };
  };

  services.postgres = {
    enable = true;
    package = pkgs.postgresql_17;
    initialDatabases = [ { name = "neoseq"; } ];
  };

  scripts.with-test-database = {
    description = "Run a command in an isolated temporary PostgreSQL database";
    exec = ./scripts/with-test-database.sh;
    packages = [
      config.services.postgres.package
      pkgs.coreutils
    ];
  };

  outputs = {
    web = pkgs.callPackage ./nix/web.nix {
      inherit mkSource;
      rustToolchain = config.languages.rust.toolchainPackage;
      nodejs = config.languages.javascript.package;
      pnpm = config.languages.javascript.pnpm.package;
    };
    sync-server = pkgs.callPackage ./nix/sync-server.nix {
      inherit mkSource;
      rustToolchain = config.languages.rust.toolchainPackage;
    };
  };

  profiles = {
    "browser-test".module = ./nix/devenv/browser-test.nix;
    "release-serve".module.neoseq.runtime = "release";
  };
}
