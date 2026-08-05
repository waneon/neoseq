{
  description = "Neoseq local Web application";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay.url = "github:oxalica/rust-overlay";
    crane.url = "github:ipetkov/crane";
  };

  outputs =
    { self, nixpkgs, flake-utils, rust-overlay, crane, ... }:
    flake-utils.lib.eachSystem [ "x86_64-linux" "aarch64-linux" "aarch64-darwin" ] (
      system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };
        lib = pkgs.lib;

        rustToolchain = pkgs.rust-bin.stable.latest.minimal.override {
          extensions = [ "clippy" "rustfmt" ];
          targets = [ "wasm32-unknown-unknown" ];
        };
        craneLib = (crane.mkLib pkgs).overrideToolchain rustToolchain;
        darwinInputs = lib.optionals pkgs.stdenv.isDarwin [ pkgs.libiconv ];

        cargoSource = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./Cargo.toml
            ./Cargo.lock
            ./deny.toml
            ./crates
            ./contracts/core-port.json
            ./fixtures/core
            ./fixtures/core-port/v3.json
            ./fixtures/core-port/v4.json
          ];
        };
        testClientFiles = lib.fileset.unions [
          ./apps/client/src/app/test-routes.tsx
          ./apps/client/src/features/verify
          ./apps/client/src/storage-test-corpus.ts
          ./apps/client/src/test-core-worker.ts
        ];
        productionClientFiles = lib.fileset.difference ./apps/client/src testClientFiles;
        webFiles = lib.fileset.unions [
            ./package.json
            ./pnpm-lock.yaml
            ./pnpm-workspace.yaml
            ./scripts/generate-i18n.mjs
            ./apps/client/package.json
            ./apps/client/components.json
            ./apps/client/index.html
            ./apps/client/public
            productionClientFiles
            ./apps/client/sw-template.js
            ./apps/client/tsconfig.app.json
            ./apps/client/tsconfig.json
            ./apps/client/tsconfig.node.json
            ./apps/client/vite.config.ts
            ./fixtures/core/property-definitions-v3.json
        ];
        webSource = lib.fileset.toSource {
          root = ./.;
          fileset = webFiles;
        };
        browserSource = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            webFiles
            testClientFiles
            ./apps/client/playwright.config.ts
            ./apps/client/vitest.config.ts
            ./apps/client/tests
            ./fixtures/core-port/v3.json
            ./fixtures/core-port/v4.json
          ];
        };
        generatedSource = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions [
            ./contracts/core-port.json
            ./scripts/check-generated.sh
            ./scripts/generate-contracts.mjs
            ./crates/domain/src/generated/core_port.rs
            ./apps/client/src/generated/core-port.ts
            ./fixtures/core-port/v3.json
            ./fixtures/core-port/v4.json
          ];
        };
        pnpmDependencyFiles = [
          ./package.json
          ./pnpm-lock.yaml
          ./pnpm-workspace.yaml
          ./apps/client/package.json
        ];
        pnpmDependencyFingerprint = builtins.substring 0 12 (
          builtins.hashString "sha256" (
            lib.concatMapStringsSep "\n" (path: builtins.hashFile "sha256" path) pnpmDependencyFiles
          )
        );
        pnpmSource = lib.fileset.toSource {
          root = ./.;
          fileset = lib.fileset.unions pnpmDependencyFiles;
        };

        commonArgs = {
          pname = "neoseq-workspace";
          version = "0.1.0";
          src = cargoSource;
          strictDeps = true;
          nativeBuildInputs = [ pkgs.cmake pkgs.pkg-config ];
          buildInputs = darwinInputs;
        };
        cargoArtifacts = craneLib.buildDepsOnly commonArgs;

        wasmArgs = commonArgs // {
          CARGO_BUILD_TARGET = "wasm32-unknown-unknown";
          cargoExtraArgs = "-p platform-web";
          doCheck = false;
        };
        wasmDevCargoArtifacts = craneLib.buildDepsOnly wasmArgs;
        coreWasmDev = craneLib.buildPackage (wasmArgs // {
          cargoArtifacts = wasmDevCargoArtifacts;
          pname = "neoseq-core-wasm-dev";
          installPhaseCommand = ''
            mkdir -p $out/lib
            cp target/wasm32-unknown-unknown/release/platform_web.wasm \
              $out/lib/neoseq_core.wasm
          '';
        });
        wasmReleaseArgs = wasmArgs // {
          CARGO_PROFILE = "wasm-release";
        };
        wasmReleaseCargoArtifacts = craneLib.buildDepsOnly wasmReleaseArgs;
        coreWasm = craneLib.buildPackage (wasmReleaseArgs // {
          cargoArtifacts = wasmReleaseCargoArtifacts;
          pname = "neoseq-core-wasm";
          installPhaseCommand = ''
            mkdir -p $out/lib
            cp target/wasm32-unknown-unknown/wasm-release/platform_web.wasm \
              $out/lib/neoseq_core.wasm
          '';
        });
        makeWasmBindings = name: wasm:
          pkgs.runCommand name {
            nativeBuildInputs = [ pkgs.wasm-bindgen-cli ];
          } ''
            mkdir -p $out
            wasm-bindgen ${wasm}/lib/neoseq_core.wasm \
              --target web --out-dir $out --out-name neoseq_core
          '';
        wasmBindings = makeWasmBindings "neoseq-wasm-bindings" coreWasm;
        wasmDevBindings = makeWasmBindings "neoseq-wasm-bindings-dev" coreWasmDev;
        coreTools = craneLib.buildPackage (commonArgs // {
          pname = "neoseq-core-tools";
          cargoExtraArgs = "-p graph-core --features test-support --bin core-scenario";
          doCheck = false;
        });

        pnpmDeps = pkgs.fetchPnpmDeps {
          # A content-derived name prevents a stale fixed-output store path from
          # hiding a manifest change when its hash was not updated.
          pname = "neoseq-client-${pnpmDependencyFingerprint}";
          version = "0.1.0";
          src = pnpmSource;
          pnpm = pkgs.pnpm_10;
          fetcherVersion = 4;
          hash = "sha256-0Zg2uvyJ10UAaWn2C8Zmq3wwloc8DHHEEATMAGUhxfQ=";
        };
        nodeInputs = [ pkgs.nodejs_22 pkgs.pnpm_10 pkgs.pnpmConfigHook ];
        nodeDerivation = src: {
          inherit src pnpmDeps;
          pnpmWorkspaces = [ "@neoseq/client" ];
          nativeBuildInputs = nodeInputs;
        };

        web = pkgs.stdenvNoCC.mkDerivation ((nodeDerivation webSource) // {
          pname = "neoseq-web";
          version = "0.1.0";
          preBuild = ''
            mkdir -p apps/client/src/wasm
            cp -R ${wasmBindings}/. apps/client/src/wasm/
          '';
          buildPhase = ''
            runHook preBuild
            pnpm --filter @neoseq/client build
            runHook postBuild
          '';
          installPhase = ''
            mkdir -p $out/share/neoseq-web
            cp -R apps/client/dist/. $out/share/neoseq-web/
          '';
        });

        browserHarness = pkgs.stdenvNoCC.mkDerivation ((nodeDerivation browserSource) // {
          pname = "neoseq-browser-harness";
          version = "0.1.0";
          preBuild = ''
            mkdir -p apps/client/src/wasm
            cp -R ${wasmDevBindings}/. apps/client/src/wasm/
          '';
          buildPhase = ''
            runHook preBuild
            pnpm --filter @neoseq/client exec tsc -b
            pnpm --filter @neoseq/client exec vite build --mode test
            runHook postBuild
          '';
          installPhase = ''
            mkdir -p $out/source
            cp -R . $out/source/
          '';
        });

        componentHarness = pkgs.stdenvNoCC.mkDerivation ((nodeDerivation browserSource) // {
          pname = "neoseq-component-harness";
          version = "0.1.0";
          dontBuild = true;
          installPhase = ''
            mkdir -p $out/source
            cp -R . $out/source/
          '';
        });

        webDevDependencies = pkgs.stdenvNoCC.mkDerivation ((nodeDerivation pnpmSource) // {
          pname = "neoseq-web-dev-dependencies";
          version = "0.1.0";
          dontBuild = true;
          installPhase = ''
            mkdir -p $out/apps/client
            cp -R node_modules $out/node_modules
            cp -R apps/client/node_modules $out/apps/client/node_modules
          '';
        });

        browserFontConfig = pkgs.makeFontsConf {
          fontDirectories = [ pkgs.dejavu_fonts ];
        };
        browserCheck = name: command: pkgs.runCommand name {
          nativeBuildInputs = [ pkgs.nodejs_22 pkgs.pnpm_10 pkgs.playwright-driver ];
          PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
          FONTCONFIG_FILE = browserFontConfig;
        } ''
          cp -R ${browserHarness}/source source
          chmod -R u+w source
          cd source/apps/client
          ${command}
          touch $out
        '';
        browserPersistenceCheck = browserCheck "neoseq-browser-persistence" "pnpm exec playwright test tests/persistence.spec.ts --project=chromium";
        webE2eCheck = browserCheck "neoseq-web-e2e" "pnpm exec playwright test e2e/";
        clientComponentCheck = pkgs.runCommand "neoseq-client-components" {
          nativeBuildInputs = [ pkgs.nodejs_22 pkgs.pnpm_10 ];
        } ''
          cp -R ${componentHarness}/source source
          chmod -R u+w source
          cd source/apps/client
          pnpm exec vitest run
          touch $out
        '';

        bundleBudget = pkgs.runCommand "neoseq-web-bundle-budget" {
          nativeBuildInputs = [ pkgs.gzip ];
        } ''
          root=${web}/share/neoseq-web
          check_gzip() {
            local label="$1" budget="$2" total=0
            shift 2
            for file in "$@"; do
              size=$(gzip -9 -n -c "$file" | wc -c)
              total=$((total + size))
            done
            echo "$label: $total bytes gzipped (budget $budget)"
            test "$total" -le "$budget"
          }
          check_raw() {
            local label="$1" budget="$2" total=0
            shift 2
            for file in "$@"; do
              size=$(wc -c < "$file")
              total=$((total + size))
            done
            echo "$label: $total raw bytes (budget $budget)"
            test "$total" -le "$budget"
          }
          check_gzip js 262144 "$root"/assets/*.js
          check_gzip css 32768 "$root"/assets/*.css
          # Step 5 embeds the SPARQL parser, optimizer, evaluator, and RDF
          # indexes in the offline Wasm core. Keep the increase explicit.
          check_raw wasm 4194304 "$root"/assets/*.wasm
          check_gzip wasm 1468006 "$root"/assets/*.wasm
          touch $out
        '';

        checks = {
          format = craneLib.cargoFmt { pname = "neoseq-format"; src = cargoSource; };
          clippy = craneLib.cargoClippy (commonArgs // {
            inherit cargoArtifacts;
            cargoClippyExtraArgs = "--workspace --all-targets --all-features -- --deny warnings";
          });
          tests = craneLib.cargoNextest (commonArgs // {
            inherit cargoArtifacts;
            cargoExtraArgs = "--workspace --all-features";
            partitions = 1;
            partitionType = "count";
          });
          core-wasm = coreWasm;
          inherit web;
          client-components = clientComponentCheck;
          bundle-budget = bundleBudget;
          licenses = craneLib.cargoDeny (commonArgs // { cargoDenyExtraArgs = "--all-features"; });
          generated = pkgs.runCommand "neoseq-generated-contracts" {
            nativeBuildInputs = [ pkgs.nodejs_22 ];
            src = generatedSource;
          } ''
            cp -R $src source
            chmod -R u+w source
            cd source
            bash scripts/check-generated.sh
            touch $out
          '';
        } // lib.optionalAttrs (!pkgs.stdenv.isDarwin) {
          browser-persistence = browserPersistenceCheck;
          web-e2e = webE2eCheck;
        };

        app = program: description: { type = "app"; inherit program; meta.description = description; };
        hostRustEnvironment = lib.optionalString pkgs.stdenv.isDarwin ''
          export LIBRARY_PATH="${pkgs.libiconv}/lib''${LIBRARY_PATH:+:$LIBRARY_PATH}"
          export NIX_LDFLAGS="-L${pkgs.libiconv}/lib ''${NIX_LDFLAGS:-}"
        '';
        browserEnvironment = ''
          export PLAYWRIGHT_BROWSERS_PATH=${pkgs.playwright-driver.browsers}
          export FONTCONFIG_FILE=${browserFontConfig}
          browser_harness="$(mktemp -d)/source"
          cp -R ${browserHarness}/source "$browser_harness"
          chmod -R u+w "$browser_harness"
        '';

        webDev = pkgs.writeShellApplication {
          name = "neoseq-web-dev";
          runtimeInputs = [ pkgs.nodejs_22 pkgs.pnpm_10 pkgs.coreutils ];
          text = ''
            project_root="$PWD"
            while [ ! -f "$project_root/apps/client/package.json" ]; do
              test "$project_root" != / || { echo "run web-dev inside the Neoseq checkout" >&2; exit 2; }
              project_root="$(dirname "$project_root")"
            done
            root_created=false
            client_created=false
            cleanup() {
              $client_created && rm -- "$project_root/apps/client/node_modules"
              $root_created && rm -- "$project_root/node_modules"
            }
            trap cleanup EXIT
            if [ ! -e "$project_root/node_modules" ]; then
              ln -s ${webDevDependencies}/node_modules "$project_root/node_modules"
              root_created=true
            fi
            if [ ! -e "$project_root/apps/client/node_modules" ]; then
              ln -s ${webDevDependencies}/apps/client/node_modules "$project_root/apps/client/node_modules"
              client_created=true
            fi
            mkdir -p "$project_root/apps/client/src/wasm"
            cp -R ${wasmDevBindings}/. "$project_root/apps/client/src/wasm/"
            chmod -R u+w "$project_root/apps/client/src/wasm"
            export NEOSEQ_VITE_CACHE_DIR="$project_root/apps/client/.vite"
            cd "$project_root"
            pnpm --filter @neoseq/client dev "$@"
          '';
        };
        webPreview = pkgs.writeShellApplication {
          name = "neoseq-web-preview";
          runtimeInputs = [ pkgs.miniserve ];
          text = ''
            host=127.0.0.1
            port=4174
            while [ "$#" -gt 0 ]; do
              case "$1" in
                --host) host="''${2:?--host requires a value}"; shift 2 ;;
                --host=*) host="''${1#*=}"; shift ;;
                --port) port="''${2:?--port requires a value}"; shift 2 ;;
                --port=*) port="''${1#*=}"; shift ;;
                -h|--help) echo "Usage: nix run .#web-preview -- [--host HOST] [--port PORT]"; exit ;;
                *) echo "unknown argument: $1" >&2; exit 2 ;;
              esac
            done
            exec miniserve \
              --interfaces "$host" \
              --port "$port" \
              --index index.html \
              --spa \
              --compress-response \
              ${web}/share/neoseq-web
          '';
        };
        rustTestApp = name: command: pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = [ rustToolchain ] ++ darwinInputs;
          text = ''${hostRustEnvironment} exec ${command} "$@"'';
        };
        testDomain = rustTestApp "neoseq-test-domain" "cargo test -p domain";
        testCoreModel = rustTestApp "neoseq-test-core-model" "cargo test -p graph-core model_";
        testCoreConvergence = rustTestApp "neoseq-test-core-convergence" "cargo test -p graph-core convergence_ -- --nocapture";
        testQueryProjection = rustTestApp "neoseq-test-query-projection" "cargo test -p query projects_";
        testQueryRebuild = rustTestApp "neoseq-test-query-rebuild" "cargo test -p query rebuild_";
        testQueryConformance = rustTestApp "neoseq-test-query-conformance" "cargo test -p query sparql_";
        testQueryDifferential = rustTestApp "neoseq-test-query-differential" "cargo test -p query differential_";
        testQueryBudget = rustTestApp "neoseq-test-query-budget" "cargo test -p query budget_";
        browserTestApp = name: command: pkgs.writeShellApplication {
          inherit name;
          runtimeInputs = [ pkgs.nodejs_22 pkgs.pnpm_10 pkgs.playwright-driver ];
          text = ''
            ${browserEnvironment}
            cd "$browser_harness/apps/client"
            exec ${command} "$@"
          '';
        };
        testIndexedDb = browserTestApp "neoseq-test-indexeddb" "pnpm exec playwright test tests/persistence.spec.ts --project=chromium";
        testE2eWeb = browserTestApp "neoseq-test-e2e-web" "pnpm exec playwright test e2e/";
        testClientComponents = pkgs.writeShellApplication {
          name = "neoseq-test-client-components";
          runtimeInputs = [ pkgs.nodejs_22 pkgs.pnpm_10 ];
          text = ''
            component_harness="$(mktemp -d)/source"
            cp -R ${componentHarness}/source "$component_harness"
            chmod -R u+w "$component_harness"
            cd "$component_harness/apps/client"
            exec pnpm exec vitest run "$@"
          '';
        };
      in
      {
        packages = {
          core-wasm = coreWasm;
          core-tools = coreTools;
          browser-harness = browserHarness;
          wasm-bindings = wasmBindings;
          inherit web;
          default = web;
        };
        inherit checks;
        apps = {
          web-dev = app "${webDev}/bin/neoseq-web-dev" "Run the Vite development server";
          web-preview = app "${webPreview}/bin/neoseq-web-preview" "Serve the production Web bundle";
          core-scenario = app "${coreTools}/bin/core-scenario" "Run the test-support core scenario tool";
          test-domain = app "${testDomain}/bin/neoseq-test-domain" "Run domain tests";
          test-core-model = app "${testCoreModel}/bin/neoseq-test-core-model" "Run core model tests";
          test-core-convergence = app "${testCoreConvergence}/bin/neoseq-test-core-convergence" "Run convergence tests";
          test-query-projection = app "${testQueryProjection}/bin/neoseq-test-query-projection" "Run RDF projection tests";
          test-query-rebuild = app "${testQueryRebuild}/bin/neoseq-test-query-rebuild" "Run derived-index rebuild tests";
          test-query-conformance = app "${testQueryConformance}/bin/neoseq-test-query-conformance" "Run SPARQL profile tests";
          test-query-differential = app "${testQueryDifferential}/bin/neoseq-test-query-differential" "Run query differential tests";
          test-query-budget = app "${testQueryBudget}/bin/neoseq-test-query-budget" "Run query budget tests";
          test-indexeddb = app "${testIndexedDb}/bin/neoseq-test-indexeddb" "Run IndexedDB/CorePort browser contracts";
          test-client-components = app "${testClientComponents}/bin/neoseq-test-client-components" "Run component tests";
          test-e2e-web = app "${testE2eWeb}/bin/neoseq-test-e2e-web" "Run Web end-to-end tests";
        };
        devShells.default = pkgs.mkShell {
          packages = [
            rustToolchain
            pkgs.nodejs_22
            pkgs.pnpm_10
            pkgs.wasm-bindgen-cli
          ] ++ darwinInputs;
          shellHook = hostRustEnvironment;
        };
        devShells.browser-test = pkgs.mkShell {
          inputsFrom = [ self.devShells.${system}.default ];
          packages = [ pkgs.playwright-driver ];
          PLAYWRIGHT_BROWSERS_PATH = pkgs.playwright-driver.browsers;
          FONTCONFIG_FILE = browserFontConfig;
        };
      }
    );
}
