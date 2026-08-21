# Graph Archive Architecture

## Contract and Identity

A `.neoseq` archive is a portable copy, never a graph identity backup or a
merge package. Every export receives a new `archive_id`. Every import creates a
new local-only graph with a new `graph_id` and replica ID, even when the same
file is imported repeatedly or its source graph already exists.

The source graph ID is provenance only. Page, block, tag, and journal IDs remain
stable inside the copied content so references and unknown forward-compatible
properties survive losslessly. Existing journals resolve by their semantic date
after import. Graph-scoped entity IRIs in supported query documents are rewritten
to the new graph ID.

## Container

Archive v1 is a ZIP using the Stored method and exactly two root entries:

```text
manifest.json   UTF-8 manifest matching contracts/graph-archive.json
graph.loro      canonical Loro snapshot using loro-snapshot/v1
```

The manifest records the archive identity, source graph and document schema,
export time, optional display-name suggestion, payload size, and SHA-256 digest.
The archive and payload are each limited to 256 MiB; the manifest is limited to
64 KiB. Extra entries, directories, other compression methods, unsupported
versions, invalid graph state, and checksum mismatches are rejected before any
graph is published.

## Export and Import

Export acquires the graph's browser write lease, requires no unresolved durable
write, takes a normal Loro snapshot in the Worker, and packages it in Wasm. It
does not mutate or compact the source graph.

Import is staged entirely in the Worker:

1. Decode and bound the container, then verify the manifest and checksum.
2. Open the source snapshot through `GraphCore` to validate its schema and
   invariants.
3. Generate the target graph and replica IDs locally and create a shallow clone
   baseline with the rewritten graph identity.
4. Reopen the clone under its target identity and validate it again.
5. Atomically install it in IndexedDB as sequence-zero Base plus metadata, then
   add its local display-name entry and navigate to the new graph.

No archive-supplied value selects an existing repository row. A failed import
leaves no partially installed graph. The imported shallow Base starts a new
history and undo boundary and has no remote origin, credentials, outbox, or sync
membership. Attaching or merging graphs is outside this contract.

## Evolution

[`../contracts/graph-archive.json`](../contracts/graph-archive.json) is the v1
manifest contract. A future reader may add an explicitly supported archive or
payload version, but it must preserve the copy-only identity rule and validate
the complete staged graph before installation. Export and import remain adapter
operations outside CorePort because they package and install platform storage.
