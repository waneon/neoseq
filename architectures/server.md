# Remote Synchronization Server Architecture

## Status and Responsibilities

The `sync-protocol` and `neoseq-server` crates provide the durable synchronization
service. The Web client consumes its account login, graph-management HTTP API,
and WebSocket protocol; the separate Admin Web app consumes its account
administration API. Identity is the PostgreSQL-backed account and opaque-session
authority behind the required `IdentityService` boundary.

The server makes a remote graph available to authorized replicas. It owns:

- authentication integration and graph membership authorization;
- durable receipt and retrieval of Loro updates;
- initial differential synchronization and live fan-out;
- checkpoint pointers, quotas, and operational audit metadata;
- ephemeral presence relay.

It does not own editor commands, well-known/default property semantics, task or
query execution, or a second canonical relational representation of pages and
blocks.

## Service Shape

The Rust service uses an async HTTP/WebSocket stack. Processes are stateless
except for disposable in-memory graph rooms. PostgreSQL is the durable system of
record, storing memberships, graph metadata, binary update
chunks, checkpoints, and acknowledgement/audit data.

Production ingress serves the static Neoseq dashboard on a private TLS origin
and routes that origin's `/v1` path to this service. The graph API also permits
cross-origin browser requests so a client may connect this server as a remote
repository. Authority is always an explicit bearer or WebSocket subprotocol
credential; the service does not use ambient cookies. No browser has a direct
path to the database.

```text
Neoseq dashboard -- authenticated HTTP -----> account/session authority
                                                     |
Neoseq client -- login / WSS --> sync session --> PostgreSQL
                                          |
                                      +--> other authorized sessions
```

A graph room holds a rehydrated Loro document and bounded connected sessions.
It is created single-flight on demand from the current checkpoint plus its
update tail and can be discarded at any time. V1 is a single-process,
single-region service; horizontal fan-out has no broker yet.

The server accepts and writes document schema v6. Room reconstruction rejects
every other schema version; this pre-release baseline has no document migration
path.

People submit a username and password only to the login endpoint. A successful
login returns a bounded opaque session credential whose digest, purpose, expiry,
and revocation state are durable. Client sessions authorize graph HTTP and WSS;
shorter Admin sessions authorize only the account-management surface. The
authenticated graph HTTP surface creates and lists graphs and lets an owner
list, grant, or revoke memberships by username while membership rows retain the
account's immutable ID. Browser WebSockets carry the session credential in
a dedicated base64url subprotocol entry because the browser API cannot set an
`Authorization` header; the server selects only the stable `neoseq.v3`
application subprotocol. Credentials are never accepted in a URL.

Graph creation has two forms. Ordinary creation commits a server-generated
empty checkpoint. Seeded creation accepts a bounded multipart checkpoint and its
SHA-256 digest, validates it through `GraphCore` under the requested target ID,
then creates graph metadata, owner membership, checkpoint, and audit event in
one database transaction. An exact retry returns the existing graph; differing
input for an occupied ID is a conflict.

## Wire Protocol

The binary protocol is versioned independently from the CRDT schema.
`contracts/sync-protocol.json` declares that version and derives the
`neoseq.v3` subprotocol name from it, generated for the server and the browser
client alike, so a bump cannot leave one side advertising the other's version.
Messages are length-delimited envelopes:

- `Hello`: exact protocol/schema versions, graph ID, session ID, history epoch,
  Loro version vector, and whether the local Base has server provenance;
- `Welcome`: history epoch, server version vector, and either a missing update
  or replacement checkpoint;
- `Update`: history epoch, client message ID, base version vector, and Loro bytes;
- `Ack`: history epoch, client message ID, and durable server receipt cursor;
- `Presence`: ephemeral cursor/selection state with expiry;
- `Error`/`ResyncRequired`: stable code and recoverability metadata.

The server sequence/cursor proves durable receipt and supports resumable
transport; it never defines CRDT conflict order. Updates are duplicate-safe. A
client keeps an outbox item until its message ID is acknowledged.

## Session Flow

1. Authenticate the connection and authorize current graph membership.
2. Require the current protocol and document-schema versions exactly.
3. If the replica lacks a server-approved Base, send a replacement checkpoint.
   Otherwise compare history epochs and Loro version vectors, exporting missing
   operations within one epoch or replacing the checkpoint across epochs.
4. For every client update, enforce limits and import into a temporary fork of
   the room document for validation.
5. Persist the exact validated bytes transactionally, then import them into the
   live room document.
6. Acknowledge only after commit, then broadcast to other sessions.
7. On reconnect, repeat version-vector reconciliation; no correctness depends on
   having observed all broadcasts.

If database commit fails, the validation fork is discarded and no live session
can observe the update. If applying to the live room fails after commit, the
room is discarded and reconstructed from durable state before any
acknowledgement.

The service periodically re-checks authorization for long-lived connections and
closes revoked sessions.

## Persistence Model

The logical PostgreSQL records are:

- account: immutable ID, unique username, Argon2id verifier, active state, and
  server-wide user/admin role;
- account session: credential digest, client/admin purpose, expiry, and
  revocation state;
- graph metadata: ID, display name, status, schema version, byte quota, history
  epoch, timestamps, and checkpoint pointer;
- membership: graph ID, account ID, role, revocation/version metadata; the
  owner membership is the canonical ownership record;
- update: graph ID, server cursor, message ID, account ID, checksum, bytes,
  size, received time;
- checkpoint: graph ID, history epoch, included cursor, shallow Loro
  snapshot/version vector, checksum, and size;
- compact receipt: graph/message ID, checksum, and original cursor for
  idempotent retries after covered update rows are reclaimed;
- audit event: account, graph, security/administrative action, timestamp.

Server administration and graph ownership are independent authorities. A
server administrator may create, disable, reset, or change the global role of
an account but does not thereby become a graph owner. Disabling an account,
changing its password or role, or explicitly revoking its sessions invalidates
all existing credentials; periodic WebSocket verification closes live sessions.

Uniqueness on `(graph_id, message_id)` across the live Tail and compact receipt
set makes recent client retry idempotent; reuse with different bytes is rejected.
Database row sequence is transport metadata only.
Graph content is not decomposed into SQL page/block tables, avoiding a competing
source of truth.

## Checkpoints and Retention

Graph creation stores an initial verified checkpoint and the room always loads
the pointed Base before its durable Tail. After 256 Tail records or 1 MiB, the
room exports a shallow checkpoint at its current cursor. One PostgreSQL
transaction inserts the new Base, copies covered message identities to compact
receipts, advances the graph pointer and `history_epoch`, and recomputes used
bytes. It retains the pointed Base, its immediate predecessor, and the Tail
needed to reconstruct from that predecessor. The next successful rotation
deletes the superseded Base and its now-unneeded Tail generation. The in-memory
room then adopts the new Base and asks connected replicas to reconnect.

A replica on the current epoch and a server-approved Base normally receives a
version-vector delta. A replica without that Base, on an older epoch, or whose
delta cannot be represented within the negotiated limit receives a replacement
checkpoint and must atomically rebase only durable unacknowledged intent. With
no such outbox intent the installed state is exactly the server Base; a shallow
snapshot representation difference is never inferred to be a local edit.
Compact receipts are capped at the most recent
4,096 messages per graph; older retries may obtain a new transport cursor, but
Loro operation identity keeps their content import idempotent.

## Security and Abuse Controls

- TLS is mandatory at the deployment ingress (the service itself binds plain
  HTTP behind that boundary); bearer/session credentials are never accepted in
  URL query strings or stored in graph updates.
- Authorization is checked outside the CRDT for every graph operation.
- Usernames are normalized, bounded identifiers but never relational identity;
  graph membership and audit records use the immutable account ID.
- Password verification runs on the blocking pool with Argon2id, login failures
  are throttled, and errors do not reveal whether an account exists.
- The first active administrator is an explicit one-time bootstrap operation.
  The service accepts a username and at least one password source through bootstrap
  configuration; a mounted secret file takes precedence over a direct environment
  value when both are set. Configuration is required before an empty identity
  store can listen, creates only when no active administrator exists, and never
  changes an existing account. Routine account management occurs only through
  the Admin Web app.
- Connection, session, frame, message, update-rate, graph-byte, presence, and
  reconstructed-document limits are enforced at their owning boundaries.
- CRDT import is treated as untrusted parsing: malformed updates fail
  atomically, are counted in aggregate operational metrics, and are never broadcast.
- Presence is rate-limited, size-limited, non-durable, and visible only to
  current graph members.
- PostgreSQL backups and storage encryption protect data at rest. V1 is
  explicitly not end-to-end encrypted.

## Availability and Backpressure

If PostgreSQL is unavailable, the service does not acknowledge writes. Clients
continue editing locally and retry later. Each session has a bounded outbound
queue; WebSocket frame/update limits bound inbound work. A slow consumer is
disconnected instead of growing memory without bound. Room reconstruction is
single-flight per graph to avoid load amplification.

Health endpoints distinguish process liveness from database readiness. Graceful
shutdown stops accepting connections, drains in-flight database commits, then
closes sessions; clients reconcile on reconnect regardless.

## Observability

Structured logs carry request/session IDs, opaque graph/account IDs, cursor,
sizes, and result codes, but never note text, property values, tokens, message
IDs, or raw update bytes. Metrics cover active sessions/rooms, accepted updates,
rejected frames, slow consumers, and room reconstruction count.

## Verification

- Protocol conformance tests run against the shared `sync-protocol` crate.
- Multi-peer tests reorder, duplicate, drop, and reconnect update streams and
  assert convergence.
- Authorization tests cover revocation during live sessions and graph isolation.
- HTTP and browser tests provision ordinary accounts through the same bootstrap,
  administration, login, and opaque-session path used by the product.
- Fault tests inject failure before/after database commit and at the committed
  update/live-import boundary, then verify acknowledgement semantics.
- Envelope tests cover malformed/version/size failures, and Loro import tests
  cover malformed and reconstructed-size limits.
- Reconstruction tests build rooms from durable checkpoints and update tails.
- Seeded-creation tests verify exact retry/conflict behavior and connect a fresh
  second client over WebSocket to the imported server Base.
- Epoch tests verify one-generation checkpoint/Tail retention and reclamation,
  replacement checkpoints, stale update rejection, and duplicate
  acknowledgement from compact receipts.

The differential exchange follows Loro's documented
[version-vector synchronization model](https://www.loro.dev/docs/tutorial/sync).
