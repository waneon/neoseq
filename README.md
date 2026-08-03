# NeoSeq

NeoSeq is a local-first outliner whose only user-facing data outside block
Markdown is a uniform typed property model. The repository is currently at the
local Web alpha stage: a browser app with journals, a virtualized outliner,
Markdown blocks, and the uniform property experience, running fully offline on
the schema-v1 domain, Loro graph core, and IndexedDB persistence. Query/task
features and remote transport follow in later steps.

## Core verification

Nix is the supported tool entry point. On a clean checkout, run:

```sh
nix run .#web-dev           # Vite development server with HMR
nix run .#web-preview       # Nix-built production bundle
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
nix run .#test-client-components
nix run .#test-e2e-web -- --project chromium
nix run .#test-e2e-web -- --project mobile-chromium
```

Both web apps listen on `127.0.0.1:4173` by default. Override the address with,
for example, `nix run .#web-dev -- --host 0.0.0.0 --port 5173` or the equivalent
`web-preview` command.

On Darwin, Playwright needs macOS host services that are unavailable inside the
Nix build sandbox; the browser gates above assemble a self-contained harness
and run it on the host. On Linux, `nix flake check` additionally runs the
hermetic `browser-persistence` and `web-e2e` checks.

The macOS build treats Xcode Command Line Tools and the macOS SDK as explicit
host inputs. `scripts/check-macos-host.sh` records them. Android SDK 36, build
tools 35.0.0 and 36.0.0, NDK r27, JDK, Rust targets, Wasm tools, Node, and
pnpm are supplied by the pinned flake. The emulator smoke command additionally
requires working host virtualization.

See [ARCHITECTURE.md](ARCHITECTURE.md) for system boundaries and
[steps/04-local-web-app.md](steps/04-local-web-app.md) for the current
local Web acceptance gate.
