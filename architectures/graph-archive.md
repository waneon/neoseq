# Graph Archive Architecture

## Contract and Identity

A `.neoseq` archive is a portable copy, never a graph identity backup or a
merge package. Every export receives a new `archive_id`. Every import creates a
new graph with a new `graph_id` and replica ID in the repository selected by the
user, even when the same file is imported repeatedly or its source graph already
exists.

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

Local import is staged in the Worker. Remote import separates preparation from
publication so the server and browser cannot acquire unrelated CRDT histories:

1. Decode and bound the container, then verify the manifest and checksum.
2. Require the current document schema and validate the source snapshot through
   `GraphCore` before creating the target graph.
3. Generate the target graph and replica IDs locally and create a shallow clone
   baseline with the rewritten graph identity.
4. Reopen the clone under its target identity and validate it again.
5. For a local repository, atomically install it as a sequence-zero Base plus
   metadata, then publish the directory entry.
6. For a remote repository, upload the prepared checkpoint, target graph ID,
   display name, and checksum to the authenticated seeded-creation endpoint.
7. The server validates the exact target snapshot and atomically creates graph
   metadata, owner membership, initial checkpoint, and audit record. Exact
   retries are idempotent; an occupied ID with different input conflicts.
8. After the returned checksum matches, atomically install those same bytes in
   IndexedDB with the returned history epoch and a server-Base marker, then
   publish the directory entry and navigate.

No archive-supplied value selects a repository or existing row. Preparation has
no durable side effect, so a failed remote creation leaves no staged browser
graph to clean up. The imported shallow Base starts a new history and undo
boundary. It is authoritative server state at creation, not an incremental
update to an independently initialized document. Attaching or merging graphs is
outside this contract.

## Evolution

[`../contracts/graph-archive.json`](../contracts/graph-archive.json) is the v1
manifest contract. A future reader may add an explicitly supported archive or
payload version, but it must preserve the copy-only identity rule and validate
the complete staged graph before installation. Export and import remain adapter
operations outside CorePort because they package and install platform storage.
The current reader requires the manifest payload schema to match its graph
schema exactly. Truncation and deterministic mutation corpora run in unit tests, and
`crates/graph-archive/fuzz` provides the untrusted decoder fuzz target.
