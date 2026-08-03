# NeoSeq

NeoSeq is a local-first outliner whose only user-facing data outside block
Markdown is a uniform typed property model. The repository is currently at the
schema-v1 domain, Loro graph core, and local-persistence/CorePort stage. The
user-facing editor and remote transport follow in later steps.

## Core verification

Nix is the supported tool entry point. On a clean checkout, run:

```sh
nix flake check
nix build .#core-native
nix build .#core-wasm
nix build .#web
nix build .#macos-smoke       # macOS host
nix build .#android-debug     # Linux or macOS host
nix run .#android-emulator-smoke  # Apple Silicon macOS smoke target
nix run .#spike-cross-runtime
nix run .#spike-persistence   # Linux; Darwin browser gate is shown below
nix run .#spike-sync
nix run .#test-domain
nix run .#test-core-model
nix run .#test-core-convergence
nix run .#core-scenario -- fixtures/core/basic.yaml
nix run .#test-persistence -- --adapter sqlite
nix run .#test-persistence -- --adapter indexeddb
nix run .#test-core-port -- --adapter native
nix run .#test-core-port -- --adapter web-worker
nix run .#test-recovery
```

On Darwin, Playwright needs macOS host services that are unavailable inside the
Nix build sandbox. Run the equivalent browser persistence gate from the pinned
devShell:

```sh
nix develop -c pnpm --filter @neoseq/client test:indexeddb
```

The macOS build treats Xcode Command Line Tools and the macOS SDK as explicit
host inputs. `scripts/check-macos-host.sh` records them. Android SDK 36, build
tools 35.0.0 and 36.0.0, NDK r27, JDK, Rust targets, Wasm tools, Node, and
pnpm are supplied by the pinned flake. The emulator smoke command additionally
requires working host virtualization.

See [ARCHITECTURE.md](ARCHITECTURE.md) for system boundaries and
[steps/03-local-persistence-and-ports.md](steps/03-local-persistence-and-ports.md)
for the current persistence acceptance gate.
