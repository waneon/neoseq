# Neoseq

Neoseq is a local-first outliner. Its current product is an offline Web
application with journals, a virtualized outline, Markdown blocks, typed
properties, tags with per-tag default properties, task controls, graph search,
and read-only SPARQL queries. A shared Rust core runs through WebAssembly in a
Worker and persists graphs to IndexedDB.

A standalone Rust synchronization server now provides authenticated WebSocket
sessions and durable PostgreSQL-backed Loro update relay. The Web product is
not connected to it yet; remote graph UX begins in
[Step 7: Remote collaboration](steps/07-remote-collaboration.md). Native
packaging, data lifecycle work, and release provenance remain planned.

## Development and verification

See [DEVELOPMENT.md](DEVELOPMENT.md) for setup, the development workflow, and
efficient test selection. devenv is the supported entry point for local work
and CI verification.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the current system and
[steps/README.md](steps/README.md) for future delivery stages.
