# Neoseq

Neoseq is a local-first outliner. The repository is at Step 5 (Local MVP): a
local Web application with journals, a virtualized outline, Markdown blocks,
uniform typed properties, task controls, a reproducible RDF index, read-only
SPARQL queries and graph search, a Rust/Wasm graph core, and IndexedDB
persistence. The UI supports English and Korean with a device-local language
preference, and its other browser-local settings — appearance, journal timezone
and date format, keyboard bindings — are split from the per-graph ones in one
settings dialog. Sync, native packaging, and release provenance belong to later steps.

## Development and verification

See [DEVELOPMENT.md](DEVELOPMENT.md) for setup, the development workflow, and
efficient test selection. Nix is the supported entry point for local work and
the CI-equivalent verification gate.

See [ARCHITECTURE.md](ARCHITECTURE.md) and
[steps/05-query-and-property-features.md](steps/05-query-and-property-features.md).
