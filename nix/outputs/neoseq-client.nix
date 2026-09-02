{
  lib,
  mkSource,
  stdenv,
  fetchPnpmDeps,
  nodejs,
  pnpm,
  pnpmConfigHook,
  rustPlatform,
  rustToolchain,
  wasm-bindgen-cli,
}:

let
  pname = "neoseq-client";
  version = (builtins.fromJSON (builtins.readFile ../../apps/client/package.json)).version;
  cargoLockDigest = builtins.hashFile "sha256" ../../Cargo.lock;
  pnpmLockDigest = builtins.hashFile "sha256" ../../pnpm-lock.yaml;
  applicationFiles = lib.fileset.unions [
    ../../Cargo.lock
    ../../Cargo.toml
    ../../contracts
    ../../crates
    ../../fixtures
    ../../package.json
    ../../patches
    ../../pnpm-lock.yaml
    ../../pnpm-workspace.yaml
    ../../apps/client/index.html
    ../../apps/client/package.json
    ../../apps/client/playwright.config.ts
    ../../apps/client/public
    ../../apps/client/src
    ../../apps/client/sw-template.js
    ../../apps/client/tsconfig.app.json
    ../../apps/client/tsconfig.json
    ../../apps/client/tsconfig.node.json
    ../../apps/client/vite.config.ts
    ../../apps/client/vitest.config.ts
    ../../scripts/generate-contracts.mjs
    ../../scripts/generate-i18n.mjs
  ];
  src = mkSource {
    name = "${pname}-source";
    root = ../../.;
    fileset = lib.fileset.difference applicationFiles (
      lib.fileset.maybeMissing ../../apps/client/src/wasm
    );
  };
in
stdenv.mkDerivation {
  inherit pname version src;
  strictDeps = true;

  cargoDeps = rustPlatform.fetchCargoVendor {
    inherit src;
    name = "${pname}-${version}-${cargoLockDigest}";
    hash = "sha256-08DKNT4fWY375FBcO9Y1clhvBqkmL/eThNQVwErfMNQ=";
  };
  pnpmDeps = fetchPnpmDeps {
    inherit version src pnpm;
    pname = "${pname}-${pnpmLockDigest}";
    fetcherVersion = 3;
    hash = "sha256-bm2fa9GcLfuJuGi5CutYa6J3msT3nP0uXMea5KcBNgQ=";
  };

  nativeBuildInputs = [
    rustToolchain
    nodejs
    pnpm
    pnpmConfigHook
    rustPlatform.cargoSetupHook
    wasm-bindgen-cli
  ];

  buildPhase = ''
    runHook preBuild

    node scripts/generate-contracts.mjs --check
    node scripts/generate-i18n.mjs --check client
    cargo build --offline --frozen --profile wasm-release --target wasm32-unknown-unknown -p platform-web
    wasm-bindgen \
      --target web \
      --out-dir apps/client/src/wasm \
      --out-name neoseq_core \
      target/wasm32-unknown-unknown/wasm-release/platform_web.wasm
    pnpm --filter @neoseq/client exec tsc -b --pretty false
    pnpm --filter @neoseq/client exec vite build

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    mkdir -p "$out"
    cp -R apps/client/dist/. "$out"

    runHook postInstall
  '';
}
