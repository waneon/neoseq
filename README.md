# NeoSeq

NeoSeq is a local-first outliner. The repository is at Step 5 (Local MVP): a
local Web application with journals, a virtualized outline, Markdown blocks,
uniform typed properties, task controls, a reproducible RDF index, read-only
SPARQL queries and graph search, a Rust/Wasm graph core, and IndexedDB
persistence. Sync, native packaging, and release provenance belong to later
steps.

## Development and verification

Nix is the supported tool entry point:

```sh
nix run .#web-dev              # checkout-backed Vite server with HMR
nix run .#web-preview          # Nix-built production bundle
nix build .#web
nix flake check

nix run .#test-domain
nix run .#test-core-model
nix run .#test-core-convergence
nix run .#test-query-projection
nix run .#test-query-rebuild
nix run .#test-query-conformance
nix run .#test-query-differential
nix run .#test-query-budget
nix run .#core-scenario -- fixtures/core/basic.yaml
nix run .#test-indexeddb
nix run .#test-client-components
nix run .#test-e2e-web -- --project chromium
```

The development server listens on `127.0.0.1:4173`; production preview uses
`127.0.0.1:4174`, so both can run together. Either accepts Vite-style host and
port overrides.

The default development shell contains the Rust, Node, pnpm, and Wasm tools
needed for core and Web work. Browser binaries are isolated in the larger
`nix develop .#browser-test` shell. On Linux, browser contracts and E2E are part
of `nix flake check`; on Darwin they run through the corresponding flake apps
because browser processes require host services unavailable in the Nix sandbox.

Production builds intentionally contain no verification route, deterministic
clock, fault-injection surface, spike relay, or native packaging artifact. The
browser contract harness is compiled separately with Vite's `test` mode.

See [ARCHITECTURE.md](ARCHITECTURE.md) and
[steps/05-query-and-property-features.md](steps/05-query-and-property-features.md).
