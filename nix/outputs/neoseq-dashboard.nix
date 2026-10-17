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
  # Everything that decides what pnpm fetches: the lock and the workspace
  # settings (patches, supported architectures).
  pnpmInputsDigest = builtins.hashString "sha256" (
    builtins.readFile ../../pnpm-lock.yaml + builtins.readFile ../../pnpm-workspace.yaml
  );
  applicationFiles = lib.fileset.unions [
    ../../assets/brand
    ../../assets/fonts
    ../../package.json
    ../../patches
    ../../pnpm-lock.yaml
    ../../pnpm-workspace.yaml
    ../../apps/dashboard/index.html
    ../../apps/dashboard/package.json
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
    pname = "${pname}-${pnpmInputsDigest}";
    fetcherVersion = 4;
    # pnpm leaves an empty `links` directory on macOS only, which would make
    # the store's hash differ between the platforms that build it.
    preFixup = ''
      rm -rf "$storePath/v11/links"
    '';
    hash = "sha256-rsg40Yn08PKgRp9HldC0OMBQEXUqfhoGlQQ13KH7eVM=";
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
