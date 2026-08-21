{
  lib,
  mkSource,
  stdenv,
  libiconv,
  rustPlatform,
  rustToolchain,
}:

let
  pname = "neoseq-sync-server";
  manifest = builtins.fromTOML (builtins.readFile ../Cargo.toml);
  version = manifest.workspace.package.version;
  cargoLockDigest = builtins.hashFile "sha256" ../Cargo.lock;
  applicationFiles = lib.fileset.unions [
    ../Cargo.lock
    ../Cargo.toml
    ../contracts
    ../crates
    ../fixtures
  ];
  src = mkSource {
    name = "${pname}-source";
    root = ../.;
    fileset = applicationFiles;
  };
in
stdenv.mkDerivation {
  inherit pname version src;
  strictDeps = true;

  cargoDeps = rustPlatform.fetchCargoVendor {
    inherit src;
    name = "${pname}-${version}-${cargoLockDigest}";
    hash = "sha256-lQ1mDcfyiVzhMQnsxqbPRoPQGwHENA/ITYJfZGLl8Yk=";
  };

  nativeBuildInputs = [
    rustToolchain
    rustPlatform.cargoSetupHook
  ];
  buildInputs = lib.optionals stdenv.hostPlatform.isDarwin [ libiconv ];

  buildPhase = ''
    runHook preBuild

    cargo build --offline --frozen --release -p sync-server

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 target/release/sync-server "$out/bin/sync-server"

    runHook postInstall
  '';

  meta.mainProgram = "sync-server";
}
