{
  cargoDeps,
  lib,
  libiconv,
  mkSource,
  rustPlatform,
  rustToolchain,
  stdenv,
}:

let
  pname = "neoseq-appliance";
  manifest = builtins.fromTOML (builtins.readFile ../../Cargo.toml);
  version = manifest.workspace.package.version;
  applicationFiles = lib.fileset.unions [
    ../../Cargo.lock
    ../../Cargo.toml
    ../../contracts
    ../../crates
    ../../fixtures
  ];
  src = mkSource {
    name = "${pname}-source";
    root = ../../.;
    fileset = applicationFiles;
  };
in
stdenv.mkDerivation {
  inherit
    cargoDeps
    pname
    src
    version
    ;
  strictDeps = true;

  nativeBuildInputs = [
    rustToolchain
    rustPlatform.cargoSetupHook
  ];
  buildInputs = lib.optionals stdenv.hostPlatform.isDarwin [ libiconv ];

  buildPhase = ''
    runHook preBuild

    cargo build --offline --frozen --release -p neoseq-appliance

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 target/release/neoseq-appliance "$out/bin/neoseq-appliance"

    runHook postInstall
  '';

  meta.mainProgram = "neoseq-appliance";
}
