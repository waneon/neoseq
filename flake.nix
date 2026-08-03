{
  description = "NeoSeq reproducible Step 1 feasibility workspace";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay.url = "github:oxalica/rust-overlay";
    crane.url = "github:ipetkov/crane";
  };

  outputs =
    inputs@{
      self,
      nixpkgs,
      flake-utils,
      rust-overlay,
      crane,
      ...
    }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ] (
      system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs {
          inherit system overlays;
          config = {
            allowUnfree = true;
            android_sdk.accept_license = true;
          };
        };
        lib = pkgs.lib;
        sourceRevision = self.rev or self.dirtyRev or "dirty";

        rustToolchain = pkgs.rust-bin.stable.latest.default.override {
          extensions = [
            "clippy"
            "rustfmt"
            "rust-src"
          ];
          targets = [
            "wasm32-unknown-unknown"
            "aarch64-linux-android"
            "armv7-linux-androideabi"
            "i686-linux-android"
            "x86_64-linux-android"
          ];
        };
        craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;

        androidComposition = pkgs.androidenv.composeAndroidPackages {
          platformVersions = [ "36" ];
          buildToolsVersions = [
            "35.0.0"
            "36.0.0"
          ];
          includeNDK = "if-supported";
          ndkVersions = [ "27.0.12077973" ];
          includeEmulator = false;
          includeSystemImages = false;
          abiVersions = [
            "arm64-v8a"
            "x86_64"
          ];
        };
        androidSdk = androidComposition.androidsdk;
        rustupShim = pkgs.writeShellScriptBin "rustup" ''
          case "''${1:-} ''${2:-}" in
            "target add")
              case "''${3:-}" in
                aarch64-linux-android|armv7-linux-androideabi|i686-linux-android|x86_64-linux-android|wasm32-unknown-unknown)
                  exit 0
                  ;;
              esac
              ;;
            "target list")
              printf '%s (installed)\n' \
                aarch64-linux-android armv7-linux-androideabi i686-linux-android \
                x86_64-linux-android wasm32-unknown-unknown
              exit 0
              ;;
          esac
          echo "rustup is replaced by the pinned Nix Rust toolchain; unsupported invocation: $*" >&2
          exit 1
        '';

        fullSource = lib.cleanSourceWith {
          src = ./.;
          filter =
            path: type:
            let
              base = baseNameOf path;
              relative = lib.removePrefix "${toString ./.}/" (toString path);
            in
            !(
              base == "target"
              || base == ".git"
              || base == ".jj"
              || base == ".direnv"
              || base == ".devenv"
              || base == "node_modules"
              || base == "dist"
              || base == "build"
              || base == ".gradle"
              || base == "test-results"
              || base == "wasm"
              || base == ".tauri"
              || base == "result"
              || lib.hasPrefix "result-" base
              || lib.hasSuffix ".tsbuildinfo" base
              || lib.hasSuffix ".so" base
              || builtins.elem relative [
                ".github"
                "architectures"
                "steps"
                "verification"
                "AGENTS.md"
                "ARCHITECTURE.md"
                "CLAUDE.md"
                "DESIGN.md"
                "README.md"
              ]
              || lib.hasPrefix ".github/" relative
              || lib.hasPrefix "architectures/" relative
              || lib.hasPrefix "steps/" relative
              || lib.hasPrefix "verification/" relative
            );
        };
        cargoSource = lib.cleanSourceWith {
          src = fullSource;
          filter = path: type:
            craneLib.filterCargoSources path type
            || lib.hasSuffix ".yaml" path
            || lib.hasSuffix ".json" path;
        };

        darwinInputs = lib.optionals pkgs.stdenv.isDarwin [ pkgs.libiconv ];
        commonArgs = {
          pname = "neoseq-workspace";
          version = "0.1.0";
          src = cargoSource;
          strictDeps = true;
          nativeBuildInputs = [
            pkgs.cmake
            pkgs.pkg-config
          ];
          buildInputs = darwinInputs;
        };
        cargoArtifacts = craneLib.buildDepsOnly (
          commonArgs
          // {
            cargoExtraArgs = "--workspace --exclude neoseq-client";
          }
        );
        cargoVendorDir = craneLib.vendorCargoDeps { src = cargoSource; };

        coreNative = craneLib.buildPackage (
          commonArgs
          // {
            inherit cargoArtifacts;
            pname = "neoseq-core-native";
            cargoExtraArgs = "-p platform-native";
            doCheck = false;
            postInstall = ''
              mkdir -p $out/share/neoseq
              cp ${toolchainManifest}/manifest.json $out/share/neoseq/toolchain.json
            '';
          }
        );

        coreTools = craneLib.buildPackage (
          commonArgs
          // {
            inherit cargoArtifacts;
            pname = "neoseq-core-tools";
            cargoExtraArgs = "-p graph-core";
            doCheck = false;
          }
        );

        wasmArgs = commonArgs // {
          CARGO_BUILD_TARGET = "wasm32-unknown-unknown";
          cargoExtraArgs = "-p platform-web";
          doCheck = false;
        };
        wasmCargoArtifacts = craneLib.buildDepsOnly wasmArgs;
        coreWasm = craneLib.buildPackage (
          wasmArgs
          // {
            cargoArtifacts = wasmCargoArtifacts;
            pname = "neoseq-core-wasm";
            installPhaseCommand = ''
              mkdir -p $out/lib $out/share/neoseq
              cp target/wasm32-unknown-unknown/release/platform_web.wasm \
                $out/lib/neoseq_core.wasm
              cp ${toolchainManifest}/manifest.json $out/share/neoseq/toolchain.json
            '';
          }
        );

        wasmBindings = pkgs.runCommand "neoseq-wasm-bindings" {
          nativeBuildInputs = [ pkgs.wasm-bindgen-cli ];
        } ''
          mkdir -p $out
          wasm-bindgen ${coreWasm}/lib/neoseq_core.wasm \
            --target web \
            --out-dir $out \
            --out-name neoseq_core
        '';

        pnpmSource = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./package.json
            ./pnpm-lock.yaml
            ./pnpm-workspace.yaml
            ./apps/client/package.json
          ];
        };
        pnpmDeps = pkgs.fetchPnpmDeps {
          pname = "neoseq-client";
          version = "0.1.0";
          src = pnpmSource;
          pnpm = pkgs.pnpm_10;
          fetcherVersion = 4;
          hash = "sha256-Qk427mZd5Wcl/O6mMxsxSkHvfzFeswxa1Exvc+llEzE=";
        };

        web = pkgs.stdenvNoCC.mkDerivation {
          pname = "neoseq-web";
          version = "0.1.0";
          src = fullSource;
          inherit pnpmDeps;
          pnpmWorkspaces = [ "@neoseq/client" ];
          nativeBuildInputs = [
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.pnpmConfigHook
          ];
          preBuild = ''
            mkdir -p apps/client/src/wasm
            cp -R ${wasmBindings}/* apps/client/src/wasm/
          '';
          buildPhase = ''
            runHook preBuild
            pnpm --filter @neoseq/client build
            runHook postBuild
          '';
          installPhase = ''
            runHook preInstall
            mkdir -p $out/share/neoseq-web/meta
            cp -R apps/client/dist/* $out/share/neoseq-web/
            cp ${toolchainManifest}/manifest.json $out/share/neoseq-web/meta/toolchain.json
            runHook postInstall
          '';
        };

        browserPersistenceCheck = pkgs.stdenvNoCC.mkDerivation {
          pname = "neoseq-browser-persistence-spike";
          version = "0.1.0";
          src = fullSource;
          inherit pnpmDeps;
          pnpmWorkspaces = [ "@neoseq/client" ];
          nativeBuildInputs = [
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.pnpmConfigHook
            pkgs.playwright-driver
          ];
          PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
          buildPhase = ''
            runHook preBuild
            mkdir -p apps/client/src/wasm
            cp -R ${wasmBindings}/* apps/client/src/wasm/
            pnpm --filter @neoseq/client build
            runHook postBuild
          '';
          doCheck = true;
          checkPhase = ''
            runHook preCheck
            pnpm --filter @neoseq/client test:indexeddb
            runHook postCheck
          '';
          installPhase = ''
            mkdir -p $out
            echo '{"adapter":"indexeddb","status":"passed"}' > $out/report.json
          '';
        };

        clientComponentCheck = pkgs.stdenvNoCC.mkDerivation {
          pname = "neoseq-client-components";
          version = "0.1.0";
          src = fullSource;
          inherit pnpmDeps;
          pnpmWorkspaces = [ "@neoseq/client" ];
          nativeBuildInputs = [
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.pnpmConfigHook
          ];
          buildPhase = ''
            runHook preBuild
            mkdir -p apps/client/src/wasm
            cp -R ${wasmBindings}/* apps/client/src/wasm/
            pnpm --filter @neoseq/client exec vitest run
            runHook postBuild
          '';
          installPhase = ''
            mkdir -p $out
            echo '{"suite":"client-components","status":"passed"}' > $out/report.json
          '';
        };

        webE2eCheck = pkgs.stdenvNoCC.mkDerivation {
          pname = "neoseq-web-e2e";
          version = "0.1.0";
          src = fullSource;
          inherit pnpmDeps;
          pnpmWorkspaces = [ "@neoseq/client" ];
          nativeBuildInputs = [
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.pnpmConfigHook
            pkgs.playwright-driver
          ];
          PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
          buildPhase = ''
            runHook preBuild
            mkdir -p apps/client/src/wasm
            cp -R ${wasmBindings}/* apps/client/src/wasm/
            pnpm --filter @neoseq/client build
            cd apps/client
            pnpm exec playwright test e2e/
            cd ../..
            runHook postBuild
          '';
          installPhase = ''
            mkdir -p $out
            echo '{"suite":"web-e2e","status":"passed"}' > $out/report.json
          '';
        };

        bundleBudget = pkgs.runCommand "neoseq-web-bundle-budget" {
          nativeBuildInputs = [ pkgs.gzip pkgs.gawk ];
        } ''
          root=${web}/share/neoseq-web
          check() {
            local label="$1" budget="$2" total=0
            shift 2
            for file in "$@"; do
              size=$(gzip -c "$file" | wc -c)
              total=$((total + size))
            done
            echo "$label: $total bytes gzipped (budget $budget)"
            if [ "$total" -gt "$budget" ]; then
              echo "bundle budget exceeded for $label" >&2
              exit 1
            fi
          }
          check "js" 262144 "$root"/assets/*.js
          check "css" 32768 "$root"/assets/*.css
          check "wasm" 2097152 "$root"/assets/*.wasm
          touch $out
        '';

        browserHarness = pkgs.stdenvNoCC.mkDerivation {
          pname = "neoseq-browser-harness";
          version = "0.1.0";
          src = fullSource;
          inherit pnpmDeps;
          pnpmWorkspaces = [ "@neoseq/client" ];
          nativeBuildInputs = [
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.pnpmConfigHook
          ];
          buildPhase = ''
            runHook preBuild
            mkdir -p apps/client/src/wasm
            cp -R ${wasmBindings}/* apps/client/src/wasm/
            pnpm --filter @neoseq/client build
            runHook postBuild
          '';
          installPhase = ''
            mkdir -p $out/source
            cp -R . $out/source/
          '';
        };

        tauriArgs = commonArgs // {
          pname = "neoseq-client";
          src = fullSource;
          cargoExtraArgs = "-p neoseq-client";
          nativeBuildInputs = commonArgs.nativeBuildInputs ++ [ pkgs.nodejs_22 ];
          preBuild = ''
            mkdir -p apps/client/dist
            cp -R ${web}/share/neoseq-web/* apps/client/dist/
          '';
          doCheck = false;
        };
        # Tauri build scripts embed generated permission paths. Reusing Crane's
        # dependency archive would retain the previous sandbox's absolute path.
        tauriBinary = craneLib.buildPackage (tauriArgs // { cargoArtifacts = null; });
        macosInfoPlist = pkgs.writeText "Info.plist" ''
          <?xml version="1.0" encoding="UTF-8"?>
          <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
          <plist version="1.0"><dict>
            <key>CFBundleExecutable</key><string>neoseq-client</string>
            <key>CFBundleIdentifier</key><string>dev.neoseq.step1</string>
            <key>CFBundleName</key><string>NeoSeq Step 1</string>
            <key>CFBundlePackageType</key><string>APPL</string>
            <key>CFBundleShortVersionString</key><string>0.1.0</string>
            <key>LSMinimumSystemVersion</key><string>11.0</string>
          </dict></plist>
        '';
        macosSmoke = pkgs.runCommand "neoseq-macos-smoke-0.1.0" { } ''
          mkdir -p "$out/NeoSeq Step 1.app/Contents/MacOS" "$out/NeoSeq Step 1.app/Contents/Resources"
          cp ${tauriBinary}/bin/neoseq-client "$out/NeoSeq Step 1.app/Contents/MacOS/neoseq-client"
          cp ${macosInfoPlist} "$out/NeoSeq Step 1.app/Contents/Info.plist"
          cp ${toolchainManifest}/manifest.json "$out/NeoSeq Step 1.app/Contents/Resources/toolchain.json"
        '';

        androidDebug = pkgs.stdenv.mkDerivation (finalAttrs: {
          pname = "neoseq-android-debug";
          version = "0.1.0";
          src = fullSource;
          inherit pnpmDeps;
          pnpmWorkspaces = [ "@neoseq/client" ];
          nativeBuildInputs = [
            rustToolchain
            rustupShim
            pkgs.cargo-tauri
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.pnpmConfigHook
            pkgs.gradle_8
            pkgs.jdk17
            androidSdk
            androidComposition.platform-tools
          ];
          mitmCache = pkgs.gradle_8.fetchDeps {
            pkg = finalAttrs.finalPackage;
            pname = finalAttrs.pname;
            data = ./nix/android-gradle-deps.json;
          };
          # preGradleUpdate performs the exact APK build under the dependency
          # recorder. Avoid resolving unrelated Android test configurations.
          gradleUpdateTask = "help";
          __darwinAllowLocalNetworking = true;
          ANDROID_HOME = "${androidSdk}/libexec/android-sdk";
          ANDROID_NDK_ROOT = "${androidSdk}/libexec/android-sdk/ndk-bundle";
          NDK_HOME = "${androidSdk}/libexec/android-sdk/ndk-bundle";
          JAVA_HOME = pkgs.jdk17.home;
          CARGO_NET_OFFLINE = "true";
          GRADLE_OPTS = "-Dorg.gradle.project.android.aapt2FromMavenOverride=${androidSdk}/libexec/android-sdk/build-tools/35.0.0/aapt2";
          preBuild = ''
            mkdir -p .cargo apps/client/src/wasm "$TMPDIR/cargo-vendor"
            cp -LR ${cargoVendorDir}/. "$TMPDIR/cargo-vendor/"
            chmod -R u+w "$TMPDIR/cargo-vendor"
            cp "$TMPDIR/cargo-vendor/config.toml" .cargo/config.toml
            substituteInPlace .cargo/config.toml \
              --replace-fail ${lib.escapeShellArg (toString cargoVendorDir)} "$TMPDIR/cargo-vendor"
            cp -R ${wasmBindings}/* apps/client/src/wasm/
            export HOME="$TMPDIR/home"
            export GRADLE_USER_HOME="$TMPDIR/gradle"
            export ANDROID_USER_HOME="$HOME/.android"
            export GRADLE_OPTS="$GRADLE_OPTS -Duser.home=$HOME"
            mkdir -p "$HOME" "$GRADLE_USER_HOME" "$ANDROID_USER_HOME"
          '';
          preGradleUpdate = ''
            export GRADLE_OPTS="$GRADLE_OPTS \
              -Dhttp.proxyHost=$MITM_CACHE_HOST -Dhttp.proxyPort=$MITM_CACHE_PORT \
              -Dhttps.proxyHost=$MITM_CACHE_HOST -Dhttps.proxyPort=$MITM_CACHE_PORT \
              -Djavax.net.ssl.trustStore=$MITM_CACHE_KEYSTORE \
              -Djavax.net.ssl.trustStorePassword=$MITM_CACHE_KS_PWD"
            cd apps/client
            cargo tauri android build --debug --apk --target aarch64 --ci
            cd src-tauri/gen/android
          '';
          buildPhase = ''
            runHook preBuild
            cd apps/client
            cargo tauri android build --debug --apk --target aarch64 --ci
            cd ../..
            runHook postBuild
          '';
          installPhase = ''
            mkdir -p $out
            cp apps/client/src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk \
              $out/neoseq-step1-debug.apk
            cp ${toolchainManifest}/manifest.json $out/toolchain.json
          '';
        });

        androidEmulatorSmoke = pkgs.androidenv.emulateApp {
          name = "neoseq-android-emulator-smoke";
          app = androidDebug;
          package = "dev.neoseq.step1";
          activity = "dev.neoseq.step1.MainActivity";
          platformVersion = "36";
          abiVersion = "arm64-v8a";
          systemImageType = "google_apis";
          configOptions = {
            "hw.keyboard" = "yes";
            "hw.gpu.enabled" = "yes";
            "hw.gpu.mode" = "host";
          };
          androidEmulatorFlags = "-no-window -no-audio -no-snapshot -no-metrics";
          sdkExtraArgs = {
            buildToolsVersions = [ "35.0.0" ];
          };
        };

        webDevDependencies = pkgs.stdenvNoCC.mkDerivation {
          pname = "neoseq-web-dev-dependencies";
          version = "0.1.0";
          src = pnpmSource;
          inherit pnpmDeps;
          pnpmWorkspaces = [ "@neoseq/client" ];
          nativeBuildInputs = [
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.pnpmConfigHook
          ];
          dontBuild = true;
          installPhase = ''
            runHook preInstall
            mkdir -p $out/apps/client
            cp -R node_modules $out/node_modules
            cp -R apps/client/node_modules $out/apps/client/node_modules
            runHook postInstall
          '';
        };

        syncServer = craneLib.buildPackage (
          commonArgs
          // {
            inherit cargoArtifacts;
            pname = "neoseq-sync-server";
            cargoExtraArgs = "-p sync-server";
            doCheck = false;
            postInstall = ''
              mkdir -p $out/share/neoseq
              cp ${toolchainManifest}/manifest.json $out/share/neoseq/toolchain.json
            '';
          }
        );

        toolchainManifest = pkgs.runCommand "neoseq-step1-toolchain-manifest" {
          nativeBuildInputs = [
            rustToolchain
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.cargo-tauri
            pkgs.jdk17
            pkgs.jq
          ];
        } ''
          mkdir -p $out
          jq -n \
            --arg system ${lib.escapeShellArg system} \
            --arg rust "$(rustc --version)" \
            --arg cargo "$(cargo --version)" \
            --arg node "$(node --version)" \
            --arg pnpm "$(pnpm --version)" \
            --arg tauri "$(cargo tauri --version)" \
            --arg java "$(java -version 2>&1 | head -1)" \
            --arg loro "1.13.7" \
            --arg revision ${lib.escapeShellArg sourceRevision} \
            --arg androidPlatform "36" \
            --arg androidBuildTools "35.0.0,36.0.0" \
            --arg androidNdk "27.0.12077973" \
            '{schema:1,source_revision:$revision,system:$system,rust:$rust,cargo:$cargo,node:$node,pnpm:$pnpm,tauri:$tauri,java:$java,loro:$loro,android:{platform:$androidPlatform,build_tools:$androidBuildTools,ndk:$androidNdk},external_host_inputs:{macos_xcode:true,macos_sdk:true,hardware_virtualization:true}}' \
            > $out/manifest.json
        '';

        checks = {
          format = craneLib.cargoFmt {
            pname = "neoseq-format";
            src = cargoSource;
          };
          clippy = craneLib.cargoClippy (
            commonArgs
            // {
              inherit cargoArtifacts;
              cargoClippyExtraArgs = "--workspace --exclude neoseq-client --all-targets -- --deny warnings";
            }
          );
          tests = craneLib.cargoNextest (
            commonArgs
            // {
              inherit cargoArtifacts;
              cargoExtraArgs = "--workspace --exclude neoseq-client";
              partitions = 1;
              partitionType = "count";
            }
          );
          inherit coreNative coreWasm web toolchainManifest;
          client-components = clientComponentCheck;
          bundle-budget = bundleBudget;
          licenses = craneLib.cargoDeny (
            commonArgs
            // {
              cargoDenyExtraArgs = "--all-features";
            }
          );
          generated = pkgs.runCommand "neoseq-generated-contracts" {
            nativeBuildInputs = [ pkgs.nodejs_22 ];
            src = fullSource;
          } ''
            cp -R $src source
            chmod -R u+w source
            cd source
            bash scripts/check-generated.sh
            touch $out
          '';
        } // lib.optionalAttrs (!pkgs.stdenv.hostPlatform.isDarwin) {
          # macOS browser processes require host services that the Nix Darwin
          # build sandbox blocks. Run the same Playwright suites via
          # `nix run` on Darwin; Linux CI retains the hermetic flake checks.
          browser-persistence = browserPersistenceCheck;
          web-e2e = webE2eCheck;
        };

        appWithDescription = program: description: {
          type = "app";
          inherit program;
          meta.description = description;
        };
        app = program: appWithDescription program "NeoSeq verification app";
        appEnvironment = ''
          export LIBRARY_PATH="${pkgs.libiconv}/lib''${LIBRARY_PATH:+:$LIBRARY_PATH}"
          export NIX_LDFLAGS="-L${pkgs.libiconv}/lib ''${NIX_LDFLAGS:-}"
        '';
        browserGateEnvironment = ''
          export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
          browser_harness="$(mktemp -d)/source"
          cp -R ${browserHarness}/source "$browser_harness"
          chmod -R u+w "$browser_harness"
        '';
        webDev = pkgs.writeShellApplication {
          name = "neoseq-web-dev";
          runtimeInputs = [
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.coreutils
          ];
          text = ''
            project_root="$PWD"
            while [ ! -f "$project_root/apps/client/package.json" ]; do
              if [ "$project_root" = / ]; then
                echo "web-dev must be run from inside the NeoSeq checkout" >&2
                exit 2
              fi
              project_root="$(dirname "$project_root")"
            done

            root_modules_created=false
            client_modules_created=false
            client_modules_dir=""
            cleanup() {
              if "$client_modules_created"; then
                if [ "$(readlink "$project_root/apps/client/node_modules")" = "$client_modules_dir" ]; then
                  rm -- "$project_root/apps/client/node_modules"
                fi
                rm -r -- "$client_modules_dir"
              fi
              if "$root_modules_created"; then
                if [ "$(readlink "$project_root/node_modules")" = "${webDevDependencies}/node_modules" ]; then
                  rm -- "$project_root/node_modules"
                fi
              fi
            }
            trap cleanup EXIT

            if [ ! -e "$project_root/node_modules" ]; then
              ln -s ${webDevDependencies}/node_modules "$project_root/node_modules"
              root_modules_created=true
            fi
            if [ ! -e "$project_root/apps/client/node_modules" ]; then
              client_modules_dir="$(mktemp -d "''${TMPDIR:-/tmp}/neoseq-web-dev-node-modules.XXXXXX")"
              client_modules_created=true
              for dependency in \
                ${webDevDependencies}/apps/client/node_modules/* \
                ${webDevDependencies}/apps/client/node_modules/.[!.]* \
                ${webDevDependencies}/apps/client/node_modules/..?*; do
                if [ -e "$dependency" ]; then
                  ln -s "$dependency" \
                    "$client_modules_dir/$(basename "$dependency")"
                fi
              done
              ln -s "$client_modules_dir" "$project_root/apps/client/node_modules"
            fi

            mkdir -p "$project_root/apps/client/src/wasm"
            cp -R ${wasmBindings}/. "$project_root/apps/client/src/wasm/"
            chmod -R u+w "$project_root/apps/client/src/wasm"

            cd "$project_root"
            pnpm --filter @neoseq/client dev "$@"
          '';
        };
        webPreview = pkgs.writeShellApplication {
          name = "neoseq-web-preview";
          runtimeInputs = [ pkgs.python3 ];
          text = ''
            host=127.0.0.1
            port=4174
            while [ "$#" -gt 0 ]; do
              case "$1" in
                --host)
                  host="''${2:-}"
                  [ -n "$host" ] || { echo "--host requires a value" >&2; exit 2; }
                  shift 2
                  ;;
                --host=*) host="''${1#*=}"; shift ;;
                --port)
                  port="''${2:-}"
                  [ -n "$port" ] || { echo "--port requires a value" >&2; exit 2; }
                  shift 2
                  ;;
                --port=*) port="''${1#*=}"; shift ;;
                -h|--help)
                  echo "Usage: nix run .#web-preview -- [--host HOST] [--port PORT]"
                  exit 0
                  ;;
                *) echo "unknown argument: $1" >&2; exit 2 ;;
              esac
            done
            exec python -m http.server "$port" \
              --bind "$host" \
              --directory ${web}/share/neoseq-web
          '';
        };
        spikeCrossRuntime = pkgs.writeShellApplication {
          name = "neoseq-spike-cross-runtime";
          runtimeInputs = [
            rustToolchain
            pkgs.nodejs_22
            pkgs.wasm-bindgen-cli
            pkgs.coreutils
          ];
          text = ''
            ${appEnvironment}
            exec ${pkgs.bash}/bin/bash ${./scripts/spike-cross-runtime.sh}
          '';
        };
        spikeSync = pkgs.writeShellApplication {
          name = "neoseq-spike-sync";
          runtimeInputs = [
            rustToolchain
            pkgs.nodejs_22
            pkgs.wasm-bindgen-cli
            pkgs.jq
            pkgs.gnugrep
            pkgs.coreutils
          ];
          text = ''
            ${appEnvironment}
            exec ${pkgs.bash}/bin/bash ${./scripts/spike-sync.sh}
          '';
        };
        spikePersistence = pkgs.writeShellApplication {
          name = "neoseq-spike-persistence";
          runtimeInputs = [
            pkgs.jq
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.playwright-driver
          ];
          text = ''
            native_report="$(${coreNative}/bin/native-spike persistence "$(mktemp -d)/step-1.sqlite")"
            ${browserGateEnvironment}
            (cd "$browser_harness/apps/client" && pnpm exec playwright test)
            browser_report='{"adapter":"indexeddb","status":"passed"}'
            jq -n --argjson native "$native_report" --argjson browser "$browser_report" \
              '{native:$native,browser:$browser,status:"passed"}'
          '';
        };
        testDomain = pkgs.writeShellApplication {
          name = "neoseq-test-domain";
          runtimeInputs = [ rustToolchain ];
          text = ''
            ${appEnvironment}
            exec cargo test -p domain "$@"
          '';
        };
        testCoreModel = pkgs.writeShellApplication {
          name = "neoseq-test-core-model";
          runtimeInputs = [ rustToolchain ];
          text = ''
            ${appEnvironment}
            exec cargo test -p graph-core model_ "$@"
          '';
        };
        testCoreConvergence = pkgs.writeShellApplication {
          name = "neoseq-test-core-convergence";
          runtimeInputs = [ rustToolchain ];
          text = ''
            ${appEnvironment}
            exec cargo test -p graph-core convergence_ -- --nocapture "$@"
          '';
        };
        browserToolInputs = [
          pkgs.nodejs_22
          pkgs.pnpm_10
          pkgs.playwright-driver
        ];
        testPersistence = pkgs.writeShellApplication {
          name = "neoseq-test-persistence";
          runtimeInputs = [ rustToolchain ] ++ browserToolInputs;
          text = ''
            ${appEnvironment}
            adapter=""
            while [ "$#" -gt 0 ]; do
              case "$1" in
                --adapter) adapter="''${2:-}"; shift 2 ;;
                *) echo "unknown argument: $1" >&2; exit 2 ;;
              esac
            done
            case "$adapter" in
              sqlite)
                exec cargo test -p platform-native persistence_ -- --nocapture
                ;;
              indexeddb)
                ${browserGateEnvironment}
                cd "$browser_harness/apps/client"
                exec pnpm exec playwright test --grep 'IndexedDB repository|IndexedDB fault'
                ;;
              *) echo "--adapter must be sqlite or indexeddb" >&2; exit 2 ;;
            esac
          '';
        };
        testCorePort = pkgs.writeShellApplication {
          name = "neoseq-test-core-port";
          runtimeInputs = [ rustToolchain ] ++ browserToolInputs;
          text = ''
            ${appEnvironment}
            adapter=""
            while [ "$#" -gt 0 ]; do
              case "$1" in
                --adapter) adapter="''${2:-}"; shift 2 ;;
                *) echo "unknown argument: $1" >&2; exit 2 ;;
              esac
            done
            case "$adapter" in
              native)
                exec cargo test -p platform-native core_port_native_ -- --nocapture
                ;;
              web-worker)
                ${browserGateEnvironment}
                cd "$browser_harness/apps/client"
                exec pnpm exec playwright test --grep 'Web Worker adapter'
                ;;
              *) echo "--adapter must be native or web-worker" >&2; exit 2 ;;
            esac
          '';
        };
        testClientComponents = pkgs.writeShellApplication {
          name = "neoseq-test-client-components";
          runtimeInputs = [
            pkgs.nodejs_22
            pkgs.pnpm_10
          ];
          text = ''
            ${browserGateEnvironment}
            cd "$browser_harness/apps/client"
            exec pnpm exec vitest run "$@"
          '';
        };
        testE2eWeb = pkgs.writeShellApplication {
          name = "neoseq-test-e2e-web";
          runtimeInputs = browserToolInputs;
          text = ''
            ${browserGateEnvironment}
            cd "$browser_harness/apps/client"
            exec pnpm exec playwright test e2e/ "$@"
          '';
        };
        testRecovery = pkgs.writeShellApplication {
          name = "neoseq-test-recovery";
          runtimeInputs = [ rustToolchain ] ++ browserToolInputs;
          text = ''
            ${appEnvironment}
            cargo test -p platform-native recovery_ -- --nocapture
            ${browserGateEnvironment}
            cd "$browser_harness/apps/client"
            exec pnpm exec playwright test --grep 'fault injection'
          '';
        };
      in
      {
        packages = {
          core-native = coreNative;
          core-wasm = coreWasm;
          core-tools = coreTools;
          browser-harness = browserHarness;
          wasm-bindings = wasmBindings;
          inherit web toolchainManifest;
          sync-server = syncServer;
          macos-smoke = macosSmoke;
          android-debug = androidDebug;
          default = web;
        } // lib.optionalAttrs pkgs.stdenv.isDarwin {
          android-emulator-smoke = androidEmulatorSmoke;
        };

        inherit checks;

        apps = {
          web-dev = appWithDescription "${webDev}/bin/neoseq-web-dev" "Run the NeoSeq Vite development server";
          web-preview = appWithDescription "${webPreview}/bin/neoseq-web-preview" "Serve the Nix-built NeoSeq production web bundle";
          core-scenario = app "${coreTools}/bin/core-scenario";
          test-domain = app "${testDomain}/bin/neoseq-test-domain";
          test-core-model = app "${testCoreModel}/bin/neoseq-test-core-model";
          test-core-convergence = app "${testCoreConvergence}/bin/neoseq-test-core-convergence";
          test-persistence = app "${testPersistence}/bin/neoseq-test-persistence";
          test-core-port = app "${testCorePort}/bin/neoseq-test-core-port";
          test-recovery = app "${testRecovery}/bin/neoseq-test-recovery";
          test-client-components = app "${testClientComponents}/bin/neoseq-test-client-components";
          test-e2e-web = app "${testE2eWeb}/bin/neoseq-test-e2e-web";
          spike-cross-runtime = app "${spikeCrossRuntime}/bin/neoseq-spike-cross-runtime";
          spike-persistence = app "${spikePersistence}/bin/neoseq-spike-persistence";
          spike-sync = app "${spikeSync}/bin/neoseq-spike-sync";
        } // lib.optionalAttrs pkgs.stdenv.isDarwin {
          android-emulator-smoke = app "${androidEmulatorSmoke}/bin/run-test-emulator";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            rustToolchain
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.wasm-bindgen-cli
            pkgs.wasm-pack
            pkgs.cargo-tauri
            pkgs.cargo-deny
            pkgs.cargo-nextest
            pkgs.jq
            pkgs.sqlite
            pkgs.postgresql
            pkgs.pkg-config
            pkgs.cmake
            pkgs.jdk17
            pkgs.playwright-driver
          ] ++ darwinInputs;
          PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
          MACOSX_DEPLOYMENT_TARGET = "11.0";
          shellHook = ''
            export LIBRARY_PATH="${pkgs.libiconv}/lib''${LIBRARY_PATH:+:$LIBRARY_PATH}"
            export NIX_LDFLAGS="-L${pkgs.libiconv}/lib ''${NIX_LDFLAGS:-}"
          '';
        };
        devShells.android = pkgs.mkShell {
          inputsFrom = [ self.devShells.${system}.default ];
          packages = [
            rustToolchain
            androidSdk
            androidComposition.platform-tools
            pkgs.gradle_8
            rustupShim
          ];
          ANDROID_HOME = "${androidSdk}/libexec/android-sdk";
          ANDROID_NDK_ROOT = "${androidSdk}/libexec/android-sdk/ndk-bundle";
          NDK_HOME = "${androidSdk}/libexec/android-sdk/ndk-bundle";
          JAVA_HOME = pkgs.jdk17.home;
          shellHook = ''
            export GRADLE_OPTS="-Dorg.gradle.project.android.aapt2FromMavenOverride=$ANDROID_HOME/build-tools/35.0.0/aapt2 ''${GRADLE_OPTS:-}"
          '';
        };
      }
    );
}
