# Repository-Qualified Graph Architecture

## Boundary

A repository is a client-visible graph namespace. The local repository always
exists. Each remote repository represents one authenticated account at one
server origin; connecting the same account and origin reuses its existing
repository rather than creating a second namespace.

The browser repository directory owns connection metadata and selection. The
server owns the authoritative catalog, display name, access role, and status of
remote graphs. Neither directory owns canonical note content.

## Identity

Every client graph reference is the pair `(repository_id, graph_id)`. Local
references use the stable repository ID `local`; remote repository IDs are
opaque browser-generated values. Server graph IDs remain server-local, so two
servers may expose the same graph ID without sharing browser storage, routes,
locks, or sync state.

CorePort v2 carries this pair in `GraphLocatorDto`. IndexedDB retains its
existing physical schema: local replicas keep their legacy graph key and remote
replicas use an encoded repository-qualified partition key. The encoded key is
an adapter detail and never becomes a canonical graph ID.

Local graph routes remain `/g/:graphId`. Remote routes are
`/r/:repositoryId/g/:graphId`; all page, journal, tag, settings, command, and
history navigation preserves that repository prefix.

## Directory and Catalog

The main screen renders repositories as tabs. Selecting a tab scopes all graph
operations:

- local lists the browser's local replica metadata;
- remote lists every graph authorized for that server account;
- cached remote replicas are marked as available offline;
- if the server is unavailable, the durable replicas remain openable;
- creating or importing targets only the selected repository.

The picker keeps catalog state under the repository ID. Revisiting a repository
shows its last successful catalog immediately while a new request revalidates
it. Revalidation never clears successful data, and an obsolete or cancelled
request cannot publish into another repository's panel. Initial loads reserve
the ordinary catalog footprint; the picker header is anchored independently of
catalog height.

Opening an uncached remote graph creates only a provisional local replica. Its
sync-state record has no server-Base provenance, so it remains read-only and says
so in protocol `Hello`; the server responds with a replacement checkpoint even
when its version vector would otherwise permit a delta. Installing that
checkpoint and provenance marker is one transaction, after which later edits
obey the same local durability contract as local graphs. Cached replicas with an
accepted Base remain editable offline. Server role and status make viewer or
revoked replicas read-only without changing their stored content.

## Authentication

The connection dialog accepts server URL, username, and password. Non-local
servers require HTTPS. A configured `NEOSEQ_URL` supplies the initial server
URL; otherwise the dialog uses the browser's current origin. The password is
sent only to the login endpoint and is discarded after exchange. Repository
metadata is stored in localStorage; the opaque, revocable session is stored in
browser storage under the repository ID. The default remembered client session
has a fixed 30-day server expiry and lives in localStorage; opting out keeps the
ordinary 12-hour session in sessionStorage. Expired or unauthorized sessions are
removed. Passwords and sessions never enter routes, graph data, archives, or the
durable repository directory.

Remote HTTP requests are cross-origin by design and always use an explicit
bearer session. WebSocket authentication uses the protocol credential entry.
The service has no cookie authority, so allowing browser origins does not grant
access by itself.

## Remote Import

Archive import always generates the target graph ID locally. The Worker validates
and prepares an independent shallow clone without installing it. For a remote
target, authenticated seeded creation uploads that checkpoint and atomically
establishes it as the server's initial Base, owner membership, and graph record.
Only a successful response with the same checksum permits the browser to install
the checkpoint with server-Base provenance. No sequence-zero history update is
created.

This is creation, not attachment: archive source identity and source sync state
are provenance only and cannot select or merge an existing remote graph.
