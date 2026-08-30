{
  lib,
  mkSource,
  stdenv,
  libiconv,
  rustPlatform,
  rustToolchain,
}:

let
  pname = "neoseq-server";
  manifest = builtins.fromTOML (builtins.readFile ../../Cargo.toml);
  version = manifest.workspace.package.version;
  cargoLockDigest = builtins.hashFile "sha256" ../../Cargo.lock;
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
  inherit pname version src;
  strictDeps = true;

  cargoDeps = rustPlatform.fetchCargoVendor {
    inherit src;
    name = "${pname}-${version}-${cargoLockDigest}";
    hash = "sha256-+kJ8bSG7uRfwfdUKhHIbQSewCrApt4S1lQWD/S79e1A=";
  };

  nativeBuildInputs = [
    rustToolchain
    rustPlatform.cargoSetupHook
  ];
  buildInputs = lib.optionals stdenv.hostPlatform.isDarwin [ libiconv ];

  buildPhase = ''
    runHook preBuild

    cargo build --offline --frozen --release -p neoseq-server

    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall

    install -Dm755 target/release/neoseq-server "$out/bin/neoseq-server"

    runHook postInstall
  '';

  meta.mainProgram = "neoseq-server";
}
