# Query and Derived Index Architecture

## Goals and Boundary

Loro is the only source of truth for graph content. Query, search, task views,
backlinks, and future graph-wide projections execute against a per-graph derived
RDF index; they never walk `LoroDoc` as their normal read path. The complete
index is reproducible from a validated Loro snapshot, so losing or deleting it
cannot lose user data.

NeoSeq uses a read-only SPARQL 1.1 profile instead of a product-specific query
DSL. Queries run only in the client Rust core. They cannot mutate CRDT state,
select another graph, contact a SPARQL endpoint, or access platform I/O.

## RDF Projection Contract

An open graph exposes one logical RDF default graph. There are no user-visible
named graphs. Stable IRIs use percent-encoded ID/key components and these
versioned namespaces:

```text
neo:  urn:neoseq:vocab:v1:
prop: urn:neoseq:property:
def:  urn:neoseq:default-property:
entity IRI: urn:neoseq:entity:<GraphId>:<kind>:<EntityId>
```

The projection emits no blank nodes. Its principal triples are:

| Loro/domain value | RDF projection |
| --- | --- |
| live page | `rdf:type neo:Page`, `neo:content` |
| live block | `rdf:type neo:Block`, `neo:content`, `neo:page`, `neo:parent`, `neo:siblingIndex` |
| live tag | `rdf:type neo:Tag`, `neo:name` |
| node tag reference | `neo:tag <tag-entity-IRI>` |
| page/block property `k = v` | `<subject> prop:<encoded-k> <typed-v>` |
| tag metadata property `k = v` | `<tag> prop:<encoded-k> <typed-v>` |
| tag default `k = v` | `<tag> def:<encoded-k> <typed-v>` |

A root block's parent is its page IRI; other blocks point to their parent block.
`neo:page` is materialized on every block for fast page scoping. Sibling indexes
are zero-based `xsd:integer` values derived from the current visible tree order.
Standard property paths such as `neo:parent+` express ancestry; a private reachability
accelerator may optimize them without changing the RDF projection.

Property values map without heuristic parsing: numbers to `xsd:double`, strings
to `xsd:string`, checkboxes to `xsd:boolean`, local dates to `xsd:date`, and page
references to page entity IRIs. Repeated values emit repeated predicates; equal
values naturally collapse under RDF set semantics, matching the source model's
idempotent member identity. A dangling page or tag reference remains an object
IRI even when no live subject describes it.

Soft-deleted entities and blocks hidden by a deleted page are absent from the
default projection. Tombstone resolution remains a core read concern rather
than implicit SPARQL filtering. Quarantined values never enter the index.

The RDF mapping, vocabulary, property-IRI encoding, Unicode normalization, and
text analyzer are checked-in compatibility fixtures. Changing any observable
mapping increments the query-profile or projection version.

## Physical Index

Each graph index is an immutable published revision backed by:

- an RDF-term dictionary with separate IRI and typed-literal identities;
- `SPO`, `POS`, and `OSP` sorted triple permutations for bound-pattern lookup
  and merge joins;
- predicate/cardinality statistics for deterministic join planning;
- an entity-to-emitted-triples ledger for precise retraction and replacement;
- normalized Markdown token/trigram postings for text search;
- an optional hierarchy reachability cache for property-path acceleration.

The first three permutations are the semantic index. Text and hierarchy data
are accelerators whose results are always verified against the same RDF
revision. They do not introduce separate query semantics.

Every revision records the graph ID, Loro frontier fingerprint, document schema,
projection version, query-profile version, and analyzer version. A persisted
cache is optional. Startup restores it only on an exact fingerprint match;
otherwise the runtime deterministically projects the current Loro snapshot.
Cache corruption or deletion causes a rebuild, never graph repair or rollback.

## Index Maintenance and Consistency

`GraphRuntime` translates each validated local or remote Loro change into a
domain entity/field change set. The projector recalculates only affected
entities, retracts their prior triples/postings through the ledger, inserts the
replacement projection, and atomically publishes one new revision. A structural
move also recalculates affected parent/page/order relations.

A query sees exactly one published revision. It may continue on the prior
revision while the next one is built, but never observes a partial delta. The
revision carries its Loro frontier, and query results report both revision and
frontier so callers can reject stale work. If delta application fails, the
runtime marks querying unavailable, rebuilds from the current validated
snapshot, and leaves canonical Loro data untouched.

## SPARQL Profile and API

V1 identifies its language as `sparql-1.1/neoseq-v1`. It supports `SELECT` and
`ASK` with basic graph patterns, `FILTER`, `BIND`, `VALUES`, `OPTIONAL`, `UNION`,
`MINUS`, `EXISTS`, subqueries, aggregates, grouping, ordering, distinct,
pagination, and property paths. `CONSTRUCT`, `DESCRIBE`, dataset clauses,
`GRAPH`, `SERVICE`, SPARQL Update, and implementation-defined extension loading
are rejected before planning. This fixes one local default graph and prevents
I/O or mutation by construction. Evaluation uses simple entailment only; the
runtime does not infer additional RDF, RDFS, or OWL triples.

Markdown search uses the sole v1 extension function
`neo:matchesText(?content, ?needle)`. The first argument must be the object of an
`neo:content` pattern and the needle must be a literal or bound parameter, which
lets the planner use postings. Its normalization and matching rules are part of
the analyzer-version fixture. All other expressions follow SPARQL 1.1 semantics.

The versioned core boundary is:

```text
query(graph_handle, {
  language: "sparql-1.1/neoseq-v1",
  source,
  bindings: Map<Variable, RdfTerm>,
  budget
}) -> SelectResult | AskResult
```

Bindings become the query's initial solution mapping; they are never inserted
through string substitution. `SelectResult` preserves declared variable order
and returns unbound, IRI, or typed-literal cells plus index revision/frontier.
Entity IRIs are additionally decoded to typed entity references at the
CorePort boundary. Unspecified result order follows SPARQL semantics; product
queries that require stable presentation must include `ORDER BY`, with entity
IRI as their final tie-breaker.

For example, the UI can store this source and bind `?today` and `?needle` as
typed values:

```sparql
PREFIX neo:  <urn:neoseq:vocab:v1:>
PREFIX prop: <urn:neoseq:property:>

SELECT ?block ?deadline WHERE {
  ?block a neo:Block ;
         prop:task.status "todo" ;
         prop:task.deadline ?deadline ;
         neo:content ?content .
  FILTER (?deadline < ?today && neo:matchesText(?content, ?needle))
}
ORDER BY ?deadline ?block
LIMIT 100
```

Autocomplete inserts vocabulary/property IRIs and stable entity IRIs; labels
remain comments or editor metadata, never identity. A block is executable when
it has `query.source: String`. New query blocks also write
`query.language: "sparql-1.1/neoseq-v1"`; a missing language uses that value for
v1 compatibility. Source and language synchronize as ordinary properties.
Plans, results, parameters, and editor state do not.

## Planning, Reactivity, and Budgets

Parsing produces source-spanned diagnostics and SPARQL algebra. The planner uses
bound terms and statistics to choose triple permutations and join order, then
lowers eligible text and path expressions to accelerators. Execution never
falls back to scanning Loro containers.

A subscribed plan declares the predicates, fixed entities, text postings, and
structural relations it depends on. A variable predicate or otherwise dynamic
pattern depends on all triple changes. After an atomic index publication, only
intersecting subscriptions debounce and re-execute; large rebuilds publish
`QueryRefreshing` and replace results atomically.

Each parse and execution has limits for source size, syntax/algebra depth,
property-path complexity, operators, elapsed time, scanned index entries,
intermediate solutions, output rows, and estimated memory. Cancellation is
checked between operators and posting batches. A limit returns a typed error,
never rows that appear complete.

## Verification

- Projection fixtures map every entity, relation, property type, repeated
  value, dangling reference, deletion, and tree move to canonical RDF terms.
- Rebuild tests discard every cache and compare the semantic triple set with
  incrementally maintained revisions after randomized command/import sequences.
- SPARQL conformance tests cover the supported W3C syntax and algebra profile;
  rejection tests cover every excluded query/update capability.
- Differential tests compare indexed execution with a test-only interpreter
  over the projected triple set, never a production Loro scan.
- Native/Wasm suites run identical projection, query, ordering, diagnostic,
  cancellation, and budget fixtures.
- Fault tests corrupt or interrupt index persistence and prove automatic rebuild
  without canonical data changes.

## Upstream Basis

Syntax and algebra semantics follow the W3C
[SPARQL 1.1 Query Language Recommendation](https://www.w3.org/TR/sparql11-query/),
except for the explicitly restricted forms and the one versioned text function
above.
