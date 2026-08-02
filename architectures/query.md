# Query Architecture

## Goals and Boundary

Users can program reusable searches over Markdown, properties, hierarchy, and
dates. Tags and task fields are queried through the same property operators as
all other non-text features. Queries are client-side derived views: they never
mutate the graph, synchronize result sets, or execute on the remote service.

V1 uses a purpose-built declarative query language rather than JavaScript, Rust,
or SQL. This provides stable semantics and prevents user queries from accessing
files, network, processes, credentials, or platform APIs. A future sandboxed
Wasm extension can be added behind the same query plan interface if the DSL
becomes insufficient.

## Pipeline Language

The textual syntax is a small pipeline compiled to a typed AST. For example:

```text
from blocks
| where property("tag") contains page("project")
    and property("task.status") == string("todo")
    and property("task.deadline") <= date($today)
| sort property("task.priority") asc
| select block, property("task.deadline")
| limit 100
```

Core constructs include:

- sources: `blocks`, `pages`;
- predicates: boolean logic, typed property comparison/membership, case-folded
  Markdown match, and ancestor/descendant relations;
- parameters such as `$today` supplied as typed values by the caller;
- projection, stable multi-key sorting, distinct, and limit;
- explicit stable page-ID references with human-readable title hints.

Autocomplete inserts stable `PageId` references with display-title hints so
renames do not break queries. A hand-written title-only reference is resolved at
compile time; ambiguity is a diagnostic, never a silent arbitrary choice. For
page rows, `property(key)` addresses the page property bag; `default(key)`
explicitly addresses its default bag.

## Compiler and Execution

```text
source -> parser -> typed AST -> resolver -> logical plan -> indexed plan -> rows
```

The compiler returns source-spanned diagnostics. Type checking prevents
comparisons such as a date against a page reference. Plans declare the entity
fields and index keys they depend on; this dependency set drives reactive
invalidation.

Execution is deterministic for a graph snapshot. Unspecified order falls back to
stable entity ID order. A result contains a runtime revision so the UI can
discard stale work completed after a newer edit.

## Derived Indexes

Indexes are per open graph and reconstructable from CRDT state:

- entity tables for pages and blocks;
- page-to-root and parent/child relationships;
- property presence and typed value indexes by key, including repeated values
  such as `tag`;
- normalized text token/trigram index;
- journal date and page title indexes.

Loro change events are translated to changed entity/field sets. The index writer
updates only affected entries and then publishes one new index revision. A query
can run against the prior complete revision or the next complete revision, never
a partially updated index.

Index caches may be persisted with the Loro version fingerprint and index-format
version. A mismatch discards and rebuilds the cache; canonical notes are
unaffected.

## Reactive Queries

The UI may subscribe to a compiled query. After each index revision, the engine
intersects changed fields/keys with the plan dependencies:

- no intersection: retain the current result;
- intersection: debounce and re-execute;
- large import/rebuild: emit `QueryRefreshing`, then replace the result
  atomically.

V1 recomputes affected result sets using indexes rather than maintaining a
complex incremental relational engine. This is simpler and leaves the plan/event
contracts ready for incremental operators if profiling justifies them.

## Resource Governance

Every execution has configurable limits for parse depth, plan operators, elapsed
time, scanned candidates, output rows, and estimated memory. Cancellation is
checked between operators and text-index batches. Exceeding a limit returns
partial diagnostics, not partial rows that look complete.

Regex, arbitrary recursion, unbounded joins, filesystem reads, network access,
and user-defined native functions are outside the v1 language. Text search uses
a documented Unicode normalization and case-folding version so native and Wasm
results match.

## Query Properties

A block becomes a query block when it has `query.source: String`. The optional
`query.language: String` selects the language version and defaults to the
current stable version. Source and version synchronize as ordinary properties;
compiled plans, results, and transient presentation state do not. Invalid query
strings remain editable property values and produce source-spanned diagnostics.

Language upgrades either remain backward compatible or provide an explicit
property-value rewrite with fixtures. Query execution never modifies
`query.source` automatically. Query-specific commands and UI are conveniences
over the generic property API, not a separate persisted model.

## Verification

- Parser/typechecker golden tests cover diagnostics and language versions.
- Property comparison tests cover all value types, missing values, and dangling
  page references.
- Uniformity tests verify tags and task fields through generic property
  operators, without feature-specific query paths.
- Differential tests compare indexed plans with a slow full-scan interpreter.
- Native/Wasm conformance tests run the same graph and query corpus.
- Fuzzing targets the parser, planner, and cancellation/resource boundaries.
- Performance suites measure edit-to-result latency on deep and wide outlines.
