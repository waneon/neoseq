# Remote Synchronization Server Architecture

## Status and Responsibilities

The `sync-protocol` and `sync-server` crates provide the durable synchronization
service, and the Web client consumes both its graph-management HTTP API
and WebSocket protocol. Production identity remains behind the `TokenVerifier`
adapter; local development uses the explicit test issuer.

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

```text
admin CLI / authenticated HTTP ----------> PostgreSQL
Web client -- WSS ---> sync session --> graph room --> PostgreSQL
                                      |
                                      +--> other authorized sessions
```

A graph room holds a rehydrated Loro document and bounded connected sessions.
It is created single-flight on demand from the current checkpoint plus its
update tail and can be discarded at any time. V1 is a single-process,
single-region service; horizontal fan-out has no broker yet.

The server writes document schema v4. A stored v1, v2, or v3 graph is migrated during
single-flight room reconstruction, installed as a new checkpoint/history epoch,
and reopened from that checkpoint before the room accepts writes. Other schema
versions are rejected.

The authenticated HTTP surface creates and lists graphs and lets an owner list,
grant, or revoke memberships. Browser WebSockets carry the bearer credential in
a dedicated base64url subprotocol entry because the browser API cannot set an
`Authorization` header; the server selects only the stable `neoseq.v2`
application subprotocol. Credentials are never accepted in a URL.

## Wire Protocol

The binary protocol is versioned independently from the CRDT schema. Messages
are length-delimited envelopes:

- `Hello`: protocol/schema range, graph ID, session ID, stable replica ID,
  history epoch, and Loro version vector;
- `Welcome`: selected protocol, graph status, limits, history epoch, server
  version vector, and either a missing update or replacement checkpoint;
- `Update`: history epoch, client message ID, base version vector, and Loro bytes;
- `Ack`: history epoch, client message ID, and durable server receipt cursor;
- `Presence`: ephemeral cursor/selection state with expiry;
- `Error`/`ResyncRequired`: stable code and recoverability metadata.

The server sequence/cursor proves durable receipt and supports resumable
transport; it never defines CRDT conflict order. Updates are duplicate-safe. A
client keeps an outbox item until its message ID is acknowledged.

## Session Flow

1. Authenticate the connection and authorize current graph membership.
2. Negotiate protocol and compatible document-schema ranges.
3. Compare history epochs and Loro version vectors. Export missing operations
   within one epoch, or send a replacement shallow checkpoint across epochs.
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

- graph metadata: ID, owner, status, schema version, byte quota, history epoch,
  and checkpoint pointer;
- membership: graph ID, principal ID, role, revocation/version metadata;
- update: graph ID, server cursor, message ID, checksum, bytes, size, received
  time;
- checkpoint: graph ID, history epoch, included cursor, shallow Loro
  snapshot/version vector, checksum, and size;
- compact receipt: graph/message ID, checksum, and original cursor for
  idempotent retries after covered update rows are reclaimed;
- audit event: principal, graph, security/administrative action, timestamp.

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

A replica on the current epoch normally receives a version-vector delta. A
replica on an older epoch—or one whose delta cannot be represented within the
negotiated limit—receives a replacement checkpoint and must atomically rebase
durable unacknowledged intent. Compact receipts are capped at the most recent
4,096 messages per graph; older retries may obtain a new transport cursor, but
Loro operation identity keeps their content import idempotent.

## Security and Abuse Controls

- TLS is mandatory at the deployment ingress (the service itself binds plain
  HTTP behind that boundary); bearer/session credentials are never accepted in
  URL query strings or stored in graph updates.
- Authorization is checked outside the CRDT for every graph operation.
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

Structured logs carry request/session IDs, opaque graph/principal IDs, cursor,
sizes, and result codes, but never note text, property values, tokens, message
IDs, or raw update bytes. Metrics cover active sessions/rooms, accepted updates,
rejected frames, slow consumers, and room reconstruction count.

## Verification

- Protocol conformance tests run against the shared `sync-protocol` crate.
- Multi-peer tests reorder, duplicate, drop, and reconnect update streams and
  assert convergence.
- Authorization tests cover revocation during live sessions and graph isolation.
- Fault tests inject failure before/after database commit and at the committed
  update/live-import boundary, then verify acknowledgement semantics.
- Envelope tests cover malformed/version/size failures, and Loro import tests
  cover malformed and reconstructed-size limits.
- Restore tests build rooms from logical backups, checkpoints, and update tails.
- Epoch tests verify one-generation checkpoint/Tail retention and reclamation,
  replacement checkpoints, stale update rejection, and duplicate
  acknowledgement from compact receipts.

The differential exchange follows Loro's documented
[version-vector synchronization model](https://www.loro.dev/docs/tutorial/sync).
