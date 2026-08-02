# NeoSeq

NeoSeq is a local-first outliner whose only user-facing data outside block
Markdown is a uniform typed property model. The repository is currently at the
foundation and technical-spike stage.

## Step 1 verification

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
nix run .#spike-persistence
nix run .#spike-sync
```

The macOS build treats Xcode Command Line Tools and the macOS SDK as explicit
host inputs. `scripts/check-macos-host.sh` records them. Android SDK 36, build
tools 35.0.0 and 36.0.0, NDK r27, JDK, Rust targets, Wasm tools, Node, and
pnpm are supplied by the pinned flake. The emulator smoke command additionally
requires working host virtualization.

See [ARCHITECTURE.md](ARCHITECTURE.md) for system boundaries and
[steps/01-foundation-and-spikes.md](steps/01-foundation-and-spikes.md) for the
current acceptance gate.
