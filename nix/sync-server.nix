{
  lib,
  stdenv,
  libiconv,
  rustPlatform,
  rustToolchain,
}:

let
  pname = "neoseq-sync-server";
  manifest = builtins.fromTOML (builtins.readFile ../Cargo.toml);
  version = manifest.workspace.package.version;
  applicationFiles = lib.fileset.unions [
    ../Cargo.lock
    ../Cargo.toml
    ../contracts
    ../crates
    ../fixtures
  ];
  src = lib.fileset.toSource {
    root = ../.;
    fileset = lib.fileset.intersection (lib.fileset.gitTracked ../.) applicationFiles;
  };
in
stdenv.mkDerivation {
  inherit pname version src;
  strictDeps = true;

  cargoDeps = rustPlatform.fetchCargoVendor {
    inherit src;
    name = "${pname}-${version}";
    hash = "sha256-WNKoT0Cuvld+asMKWXTXq2C3FjevPpijg/Q9yDz9nko=";
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
