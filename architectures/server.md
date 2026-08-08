# Remote Synchronization Server Architecture

## Status and Responsibilities

This is the Step 6 target architecture. There is currently no sync server or
wire-protocol crate, so implementation begins with these production constraints
instead of inheriting a placeholder transport.

The server makes a remote graph available to authorized replicas. It owns:

- authentication integration and graph membership authorization;
- durable receipt and retrieval of Loro updates;
- initial differential synchronization and live fan-out;
- checkpoints, retention, quotas, and operational audit metadata;
- ephemeral presence relay.

It does not own editor commands, well-known/default property semantics, task or
query execution, or a second canonical relational representation of pages and
blocks.

## Service Shape

The Rust service uses an async HTTP/WebSocket stack. Processes are stateless
except for disposable in-memory graph rooms. PostgreSQL is the durable system of
record in v1, storing accounts/memberships, graph metadata, binary update
chunks, checkpoints, and acknowledgement/audit data.

```text
client -- HTTPS --> auth/graph metadata API --> PostgreSQL
client -- WSS ---> sync session --> graph room --> PostgreSQL
                                      |
                                      +--> other authorized sessions
```

A graph room holds a rehydrated Loro document, connected sessions, and recent
updates. It is created on demand from the newest checkpoint plus its update tail
and can be discarded at any time. Multiple service instances coordinate room
ownership or fan-out through a small broker only when horizontal scaling
requires it; the v1 single-region deployment does not introduce a broker
prematurely.

## Wire Protocol

The binary protocol is versioned independently from the CRDT schema. Messages
are length-delimited envelopes:

- `Hello`: protocol/schema range, graph ID, session ID, Loro version vector,
  last acknowledgement, and optional presence metadata;
- `Welcome`: selected protocol, graph status, limits, server version vector, and
  missing-update stream or checkpoint offer;
- `Update`: client message ID, base metadata, and Loro update bytes;
- `Ack`: client message ID and durable server receipt cursor;
- `Presence`: ephemeral cursor/selection state with expiry;
- `Error`/`ResyncRequired`: stable code and recoverability metadata.

The server sequence/cursor proves durable receipt and supports resumable
transport; it never defines CRDT conflict order. Updates are duplicate-safe. A
client keeps an outbox item until its message ID is acknowledged.

## Session Flow

1. Authenticate the connection and authorize current graph membership.
2. Negotiate protocol and compatible document-schema ranges.
3. Compare Loro version vectors. Export missing server operations and import
   valid client operations.
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

- graph metadata: ID, owner, status, schema range, byte quota, checkpoint
  pointer;
- membership: graph ID, principal ID, role, revocation/version metadata;
- update: graph ID, server cursor, message ID, checksum, bytes, size, received
  time;
- checkpoint: graph ID, included cursor, Loro snapshot/version, checksum, size;
- audit event: principal, graph, security/administrative action, timestamp.

Uniqueness on `(graph_id, message_id)` makes client retry idempotent. Database
row sequence is transport metadata only. Graph content is not decomposed into
SQL page/block tables, avoiding a competing source of truth.

## Checkpoints and Retention

A background worker reconstructs a graph, verifies it, exports a checkpoint, and
commits the checkpoint pointer before old update chunks become eligible for
retention cleanup. At least one prior verified checkpoint is retained during the
cleanup window. Slow clients can receive a checkpoint plus tail when their
version is older than retained incremental history.

Update retention must respect Loro's supported shallow/history export semantics.
Before enabling deletion in production, convergence and offline-client restore
are verified against the pinned Loro version.

## Security and Abuse Controls

- TLS is mandatory; bearer/session credentials are never accepted in URL query
  strings or stored in graph updates.
- Authorization is checked outside the CRDT for every graph operation.
- Per-user, connection, message, update, graph-size, and decompressed-size
  limits are enforced before expensive processing.
- CRDT import is treated as untrusted parsing: malformed updates fail
  atomically, are counted in aggregate operational metrics, and are never broadcast.
- Presence is rate-limited, size-limited, non-durable, and visible only to
  current graph members.
- PostgreSQL backups and storage encryption protect data at rest. V1 is
  explicitly not end-to-end encrypted.

## Availability and Backpressure

If PostgreSQL is unavailable, the service does not acknowledge writes. Clients
continue editing locally and retry later. Each session has bounded inbound and
outbound queues; a slow consumer is disconnected with `ResyncRequired` instead
of growing memory without bound. Room reconstruction is single-flight per graph
to avoid load amplification.

Health endpoints distinguish process liveness from database readiness. Graceful
shutdown stops accepting connections, drains in-flight database commits, then
closes sessions; clients reconcile on reconnect regardless.

## Observability

Structured logs and traces carry request/session IDs, opaque graph IDs, cursor,
sizes, timing, and result codes, but never note text, property values, tokens,
or raw update bytes. Metrics cover active sessions/rooms, update and checkpoint
latency, bytes, queue pressure, rejected frames, reconnects, and room
reconstruction time.

## Verification

- Protocol conformance tests will run against the shared `sync-protocol` crate
  introduced with the service.
- Multi-peer tests reorder, duplicate, drop, and reconnect update streams and
  assert convergence.
- Authorization tests cover revocation during live sessions and graph isolation.
- Fault tests kill the service before/after database commit and verify
  acknowledgement semantics.
- Fuzzing covers envelope parsing and Loro import limits.
- Restore drills build rooms from backups, checkpoints, and retained tails.

The differential exchange follows Loro's documented
[version-vector synchronization model](https://www.loro.dev/docs/tutorial/sync).
