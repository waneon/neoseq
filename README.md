# Neoseq

Neoseq is a local-first outliner. Its current product is an offline Web
application with journals, a virtualized outline, Markdown blocks, typed
properties, task controls, graph search, and read-only SPARQL queries. A shared
Rust core runs through WebAssembly in a Worker and persists graphs to IndexedDB.

Remote synchronization, native packaging, data migration, and release
provenance are planned work. The active implementation plan starts with
[Step 6: Sync server](steps/06-sync-server.md).

## Development and verification

See [DEVELOPMENT.md](DEVELOPMENT.md) for setup, the development workflow, and
efficient test selection. Nix is the supported entry point for local work and
the CI-equivalent verification gate.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the current system and
[steps/README.md](steps/README.md) for future delivery stages.
