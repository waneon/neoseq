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
  pname = "neoseq-dashboard";
  version = (builtins.fromJSON (builtins.readFile ../../apps/dashboard/package.json)).version;
  pnpmLockDigest = builtins.hashFile "sha256" ../../pnpm-lock.yaml;
  applicationFiles = lib.fileset.unions [
    ../../package.json
    ../../patches
    ../../pnpm-lock.yaml
    ../../pnpm-workspace.yaml
    ../../apps/dashboard/index.html
    ../../apps/dashboard/package.json
    ../../apps/dashboard/public
    ../../apps/dashboard/src
    ../../apps/dashboard/tsconfig.json
    ../../apps/dashboard/vite.config.ts
    ../../scripts/generate-i18n.mjs
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
    hash = "sha256-G+YdxD9GKFUv9SaSwtW+AcW9KPwR2LUirhumF2EFXsA=";
  };

  nativeBuildInputs = [
    nodejs
    pnpm
    pnpmConfigHook
  ];

  buildPhase = ''
    runHook preBuild

    node scripts/generate-i18n.mjs --check dashboard
    pnpm --filter @neoseq/dashboard exec tsc -p tsconfig.json --pretty false
    pnpm --filter @neoseq/dashboard exec vite build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out"
    cp -R apps/dashboard/dist/. "$out"

    runHook postInstall
  '';
}
