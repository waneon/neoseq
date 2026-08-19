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
  pname = "neoseq-web";
  version = (builtins.fromJSON (builtins.readFile ../apps/client/package.json)).version;
  applicationFiles = lib.fileset.unions [
    ../Cargo.lock
    ../Cargo.toml
    ../contracts
    ../crates
    ../fixtures
    ../package.json
    ../pnpm-lock.yaml
    ../pnpm-workspace.yaml
    ../apps/client/index.html
    ../apps/client/package.json
    ../apps/client/playwright.config.ts
    ../apps/client/public
    ../apps/client/src
    ../apps/client/sw-template.js
    ../apps/client/tsconfig.app.json
    ../apps/client/tsconfig.json
    ../apps/client/tsconfig.node.json
    ../apps/client/vite.config.ts
    ../apps/client/vitest.config.ts
    ../scripts/generate-contracts.mjs
    ../scripts/generate-i18n.mjs
  ];
  src = mkSource {
    name = "${pname}-source";
    root = ../.;
    fileset = lib.fileset.difference applicationFiles (
      lib.fileset.maybeMissing ../apps/client/src/wasm
    );
  };
in
stdenv.mkDerivation {
  inherit pname version src;
  strictDeps = true;

  cargoDeps = rustPlatform.fetchCargoVendor {
    inherit src;
    name = "${pname}-${version}";
    hash = "sha256-sOz2WpYRUj8ycIfj+doOOHUjDlaAjq+PhXB/YCF2ZEM=";
  };
  pnpmDeps = fetchPnpmDeps {
    inherit
      pname
      version
      src
      pnpm
      ;
    fetcherVersion = 3;
    hash = "sha256-tcK06qkcm2uHTN/zW1ejwUowTw9Gy+H5CgG1R7OFxiU=";
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
    node scripts/generate-i18n.mjs --check
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
