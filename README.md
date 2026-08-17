# Neoseq

Neoseq is a local-first outliner. Its current product is an offline Web
application with journals, a virtualized outline, Markdown blocks, typed
properties, tags with per-tag default properties, task controls, graph search,
and read-only SPARQL queries. A shared Rust core runs through WebAssembly in a
Worker and persists graphs to IndexedDB.

Remote graphs connect that local replica to an authenticated Rust WebSocket
service with durable PostgreSQL-backed Loro update relay. The Web client keeps
editing offline, retries its durable outbox on reconnect, supports member
management and ephemeral presence, and keeps local-save, remote-sync, and live
connection status separate. This is the completed Remote beta; native
packaging, data lifecycle work, and release provenance remain planned in
[steps/](steps/).

## Development and verification

See [DEVELOPMENT.md](DEVELOPMENT.md) for setup, the development workflow, and
efficient test selection. devenv is the supported entry point for local work
and CI verification.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the current system and
[steps/README.md](steps/README.md) for future delivery stages.
