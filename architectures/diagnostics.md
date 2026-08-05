# Diagnostic Recording and Bug Artifact Architecture

## Status and Purpose

The Web client implements the content-free `standard` recorder, crash recovery,
`.neoseq-bug` writer, and local inspector. Standard state-relationship checkpoints
and the `enhanced` option specified here are the next implementation scope. Native
hosts, replay, cross-clock calibration, and sanitized frames remain future work.

Diagnostic recording turns a user-observed failure into bounded, structured
evidence that a human or coding agent can inspect. A recording connects one
user action to UI, `CorePort`, Worker/native adapter, core, persistence, query,
and render stages. It is useful for correctness failures and performance
regressions without making telemetry or content collection a prerequisite.

The feature is not a general analytics system, a remote monitoring service, or
a promise of deterministic replay. A standard artifact intentionally omits
content and may establish where a failure occurred without containing the data
needed to reproduce it.

## Product Contract

The user explicitly starts and stops each recording. Start is available as one
canonical application command and from Settings; recording state remains
visible and accessible across navigation until it is stopped or its limit is
reached. Before any event is retained, starting explains the selected capture
level, scope, limits, and exclusions. Stopping opens a review that shows:

- duration, size, event count, dropped-event count, and active limits;
- the categories collected and excluded;
- every content-bearing attachment, separately classified with preview/removal
  controls;
- actions to save locally or discard.

Saving creates a local file. The application does not silently upload, attach,
or retain the artifact. Cancel and discard remove the temporary recording. A
recording interrupted by a crash or reload can be recovered on the next launch;
the application asks whether to export or discard it and expires abandoned
temporary data after a short, policy-versioned interval.

Recording does not change graph semantics, durability, synchronization, or
error handling. Failure reporting continues through the normal UI while the
recorder observes the same failure.

Only one application-wide recording may exist. Its explicit state machine is
`idle -> consent -> recording -> finalizing -> review -> idle`; a crash or
reload recovers an unfinished recording directly into review, from which it can
only be saved or discarded. Finalization is idempotent, and starting another
recording cannot overwrite recoverable data.

The capture level and content scope are immutable once recording starts. Standard
cannot be promoted mid-recording or used to collect content retroactively. Enhanced
is a one-recording choice, never a remembered preference; another enhanced run
requires fresh consent. Exporting any sensitive payload requires a second confirmation.

## Capture Levels and Privacy

`CapturePolicy` is a closed union: `{ level: "standard" }` or
`{ level: "enhanced", scope, categories }`. Invalid combinations cannot reach a sink.

The default `standard` level records only allowlisted structured fields. It
never records:

- page, block, or tag text and names;
- property values, custom property keys, query source, or query results;
- keystrokes, IME buffers, selections, clipboard data, or accessibility text;
- raw CRDT bytes, graph archives, attachments, or sync frames;
- credentials, cookies, request headers, full URLs, or URL query/fragment data;
- stable graph/entity/peer/account identifiers, filesystem paths, or arbitrary
  error messages.

Text is represented by length buckets and operation shape, not by a hash;
hashing user text would permit dictionary attacks. Stable identifiers needed to
join events become recording-scoped opaque tokens. Standard may record value
relationships such as `equal`, `different`, `missing`, or `unknown`, but never the
values being compared. Route kinds and well-known property keys are allowed; raw
route values and custom keys are not.

Standard state checkpoints correlate semantic boundaries rather than keystrokes.
They may include command/result `changed`, command and snapshot revisions, hydrated
scope, pending-command count, focus/composition state, draft/baseline presence,
length buckets, and draft-to-baseline or draft-to-authoritative relationships. A
checkpoint is attached to the same recording-scoped entity token and trace as the
command that caused reconciliation. This makes stale presentation state, missed
refreshes, and ordering faults diagnosable without revealing content.

Environment data is minimized. Exact app/contract/schema versions and adapter
kind are allowed because they select code paths. Locale, UTC offset, viewport,
memory, and processor information use coarse categories when available. Exact
location, device name, extension inventory, and unrelated browser capabilities
are excluded. Unsupported metrics appear as absent capabilities rather than
synthetic zero values.

`enhanced` adds only the content categories and scope shown at consent. The initial
scope choices are the active page, entities touched during recording, and an optional
full-graph snapshot through the verified export path; the active page is the default.
Exact note/name/property/query content, command payloads, identifiers, and raw product
errors may be included only when their category is selected. Sensitive payloads are
segregated from standard streams and linked through recording-scoped references.

Enhanced still never captures credentials, cookies, authorization or request headers,
password/payment fields, clipboard data, unrelated browser storage, filesystem paths,
or URL query/fragment data. It does not enable network capture, console scraping, or
blanket logging. Scope expansion requires a new recording and fresh consent.

## Component Boundaries

Diagnostics is an observation plane, not a domain capability:

```text
typed boundary spans ───┐                       ┌─> standard streams
editor state relations ─┼─> DiagnosticsCoordinator ─> temporary store/writer
storage/query metrics ──┘              │        └─> manifest + review inventory
                                       │
consented scoped content ──> enhanced payload sink ─> sensitive/
                              (inactive in standard)
```

- `features/diagnostics/` owns start, visible recording state, stop, review,
  attachment consent, save, recovery, and discard UX.
- The Web `DiagnosticsCoordinator` owns the state machine, capture policy,
  enhanced scope, budgets, ordering, and temporary-store coordination.
- `DiagnosticSink` accepts standard-safe types; a separate enhanced payload sink
  exists only while that policy is active. Neither accepts arbitrary maps or strings.
- IndexedDB and browser download APIs are the current Web host. Native support
  will extract a `DiagnosticsHost` for metadata, temporary storage, and saving;
  it remains outside `CorePort`, whose contract is graph semantics only.
- Platform adapters propagate optional recording-scoped trace context to their
  internal Worker/native calls. It never enters domain commands, Loro state,
  sync messages, or server storage.
- `domain` remains unaware of diagnostics. `graph-core`, `query`, and repository
  adapters may emit allowlisted spans through an optional sink; absence of a
  sink has no semantic effect.

The recorder wraps boundaries instead of adding logging calls to React feature
components ad hoc. A new captured field is a schema and privacy-policy change,
not an unreviewed string passed to a logger.

## Trace and Event Model

Every record has an artifact-schema version, monotonically increasing sequence,
source, event type, and monotonic timestamp. Operations have a random
recording-scoped `trace_id`; nested stages use `span_id` and `parent_span_id`.
The Web adapter translates Worker-relative offsets from the request dispatch
boundary; it does not yet claim calibrated cross-clock uncertainty. Wall-clock
time is stored only for the recording boundary in UTC.

The standard schema permits these record families:

- `interaction`: semantic action name and input shape, never raw input;
- `span`: enqueue/start/end/cancel status, duration, payload-size bucket, queue
  depth, stable result code, and whether a semantic command changed state;
- `state`: route/save/sync/lease state, revisions, graph-size buckets, and typed
  editor relationships between local draft, baseline, and authoritative state;
- `metric`: long-task, render-commit, memory-pressure, storage, query, and
  transport measurements when the platform exposes them safely;
- `error`: stable error code, recoverability, and owning boundary; sanitized
  product-only frames are a future additive field;
- `marker`: start, stop, limit, crash recovery, user annotation, truncation,
  dropped records, and clock calibration.

User annotations are the sole free-form standard-artifact field. The review UI
labels them as user-entered content, displays them verbatim, and allows removal
before export. Error messages, panic payloads, DOM text, console output, and raw
stack strings never flow into that field.

The initial end-to-end stages are:

```text
interaction -> GraphSession -> CorePort enqueue -> adapter receive
            -> core execute/query -> repository/sync -> semantic event
            -> session reconciliation -> render commit
```

Each stage can be absent and declares its instrumentation capability in the
manifest. Missing spans are not interpreted as zero-duration work.

## Buffering, Persistence, and Overhead

Recording is bounded by policy version. Initial defaults are 15 minutes,
20 MiB of encoded standard diagnostic data before ZIP compression, and 50,000
structured records. Reaching any hard limit stops capture, preserves the
records already collected, and creates a visible `limit_reached` marker. Size
and count limits apply before allocation to unexpectedly large fields. Enhanced
payloads have a separate 50 MiB bound; an oversized scope or graph snapshot is
rejected rather than expanding either budget.

Producers write to a bounded in-memory queue and never wait for artifact I/O.
The hard bounds reserve capacity for the terminal lifecycle marker, and the
artifact exposes an aggregate dropped count. Metrics are sampled, text edits are
coalesced at the existing command boundary, and the recorder does not observe
individual keystrokes.

For crash recovery, sanitized batches are asynchronously checkpointed outside
the command and render critical paths. Web uses a dedicated IndexedDB
diagnostics store; native clients use application-cache temporary storage.
Neither is part of the graph repository, graph backup, Service Worker cache, or
sync outbox.

Temporary records use per-recording random IDs, remain local, and are deleted
after a browser download is initiated, explicit discard, or expiry. A failed
artifact build keeps the recoverable temporary copy until retry or discard.

## Artifact Contract

`.neoseq-bug` is a versioned ZIP container with media type
`application/vnd.neoseq.bug+zip`. Names are fixed, relative, and UTF-8:

```text
manifest.json
summary.json
events.jsonl
metrics.jsonl
errors.jsonl
schemas/manifest.schema.json
schemas/record.schema.json
README.md
checksums.sha256
sensitive/content.jsonl       # enhanced payloads and scoped checkpoints
sensitive/graph.neoseq        # optional enhanced full-graph snapshot
```

`manifest.json` contains artifact/policy versions, recording boundary and
duration, application/build identity, platform and instrumentation
capabilities, clock description, active bounds, truncation/drop counts,
redaction/capture level, consented categories/scope, and a classified inventory.
Build identity comes from
the application version plus `NEOSEQ_BUILD_ID` injected at the Vite boundary;
development builds identify themselves explicitly. Independent Web/core asset
hashes remain a release-provenance extension.

JSON Lines keeps partial captures inspectable after an interrupted recording.
Sequence numbers are global across streams, and each JSONL file is sequence
ordered; trace relationships, not file adjacency, are the causal contract.
`summary.json` is a deterministic index of errors, slowest spans, counts, and
recording gaps. `README.md` explains the privacy level and exact inspection
commands without interpreting the bug. Embedded schemas make the artifact
self-describing. Checksums cover every payload file except the checksum list
itself; they detect accidental corruption but do not authenticate a reporter.

Artifact writers use deterministic field ordering, normalized timestamps, and
bounded compression. A content attachment is listed in both the manifest and
review UI with its classification, size, and checksum. Unknown optional files
are ignored by compatible readers; an unknown required feature causes a clear
unsupported-artifact result.

## Coding-Agent Inspection and Replay

The supported entry point is a non-mutating command such as:

```text
pnpm diagnostics:inspect -- report.neoseq-bug
```

It validates the bounded container and record envelope, verifies checksums, and
reports redaction, truncation, gaps, and the slowest correlated spans. It must
not require network access, import a graph, render user content, or execute artifact data.
Machine-readable output is available so a coding agent can cite trace IDs,
durations, error codes, and source boundaries. Sensitive files are only inventoried
unless the operator supplies an explicit `--allow-sensitive` access flag.

Replay is a separate, explicit operation and is unavailable for a standard
artifact. If a content snapshot and a compatible command stream are present,
replay creates a disposable profile, disables network and sync, verifies all
limits, and never opens or replaces the user's normal graph. A tool or agent
must require an explicit content-access flag before reading `sensitive/`.

All submitted artifacts are untrusted input. Readers reject path traversal,
links, duplicate names, excessive file count, excessive compressed or expanded
size, oversized JSON lines, deep nesting, invalid UTF-8, and checksum mismatch.
Artifact strings are data, never shell arguments, HTML, Markdown execution, or
paths to open automatically.

## Verification and Evolution

- Schema fixtures cover complete, truncated, crash-recovered, content-free,
  content-bearing, and newer-compatible artifacts.
- Privacy tests prove standard excludes every canary, enhanced includes only
  consented categories/scope, and always-forbidden secrets remain absent.
- Future contract tests will run the same synthetic trace through Web Worker
  and native adapters and verify correlation, clock uncertainty, ordering, and gaps.
- Fault tests cover queue overflow, storage quota, crash between checkpoints,
  failed save, archive corruption, and cleanup after save/discard/expiry.
- Performance tests compare recording off/on for typing, command, query, and
  persistence paths and enforce an explicit overhead budget before release.
- Parser tests and fuzzing cover ZIP and JSONL limits; replay tests prove profile
  isolation and disabled network access.
- Accessibility tests cover level/scope disclosure, persistent state, automatic
  stop, sensitive export confirmation, review, save failure, and recovery.

Artifact schema and capture-policy versions evolve independently from
`CorePort`, document schema, query profile, and sync protocol. Additive optional
records remain readable by older analyzers. A new field, relationship signal,
content category, or wider scope increments capture policy and requires renewed
privacy review. Required semantic changes increment
artifact schema and ship compatibility fixtures with both writer and reader.
