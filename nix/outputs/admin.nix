{
  lib,
  mkSource,
  stdenv,
  fetchPnpmDeps,
  nodejs,
  pnpm,
  pnpmConfigHook,
}:

let
  pname = "neoseq-admin";
  version = (builtins.fromJSON (builtins.readFile ../../apps/admin/package.json)).version;
  pnpmLockDigest = builtins.hashFile "sha256" ../../pnpm-lock.yaml;
  applicationFiles = lib.fileset.unions [
    ../../package.json
    ../../patches
    ../../pnpm-lock.yaml
    ../../pnpm-workspace.yaml
    ../../apps/admin/index.html
    ../../apps/admin/package.json
    ../../apps/admin/src
    ../../apps/admin/tsconfig.json
    ../../apps/admin/vite.config.ts
  ];
  src = mkSource {
    name = "${pname}-source";
    root = ../../.;
    fileset = applicationFiles;
  };
in
stdenv.mkDerivation {
  inherit pname version src;
  strictDeps = true;

  pnpmDeps = fetchPnpmDeps {
    inherit version src pnpm;
    pname = "${pname}-${pnpmLockDigest}";
    fetcherVersion = 3;
    hash = "sha256-uIOyGzwRfe3eIHGgAEV34MEKbcH4SAbC9K3t+GfJQE4=";
  };

  nativeBuildInputs = [
    nodejs
    pnpm
    pnpmConfigHook
  ];

  buildPhase = ''
    runHook preBuild

    pnpm --filter @neoseq/admin exec tsc -p tsconfig.json --pretty false
    pnpm --filter @neoseq/admin exec vite build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out"
    cp -R apps/admin/dist/. "$out"

    runHook postInstall
  '';
}
