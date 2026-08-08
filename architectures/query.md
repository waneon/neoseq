# Query and Derived Index Architecture

## Goals and Boundary

Loro is the only source of truth for graph content. Query, search, task views,
backlinks, and future graph-wide projections execute against a per-graph derived
RDF index; they never walk `LoroDoc` as their normal read path. The complete
index is reproducible from a validated Loro snapshot, so losing or deleting it
cannot lose user data.

Neoseq uses a read-only SPARQL 1.1 profile instead of a product-specific query
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
| entity property field `k` | `<subject> neo:hasProperty <property-key-IRI>` |
| page/block property `k = v` | `<subject> prop:<encoded-k> <typed-v>` |
| tag metadata property `k = v` | `<tag> prop:<encoded-k> <typed-v>` |
| tag default field `k` | `<tag> neo:hasDefaultProperty <property-key-IRI>` |
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
An empty field emits only its presence relation and no value predicate.

Soft-deleted entities and blocks hidden by a deleted page are absent from the
default projection. Tombstone resolution remains a core read concern rather
than implicit SPARQL filtering. Quarantined values never enter the index.

The RDF mapping, vocabulary, property-IRI encoding, Unicode normalization, and
text analyzer are covered by checked-in conformance fixtures. Changing an
observable mapping requires a corresponding profile or projection version.

## Physical Index

Each open graph owns an Oxigraph in-memory store backed by:

- an RDF-term dictionary and the store's triple permutations;
- Oxigraph's SPARQL parser, optimizer, and evaluator;
- an entity-to-emitted-triples ledger for precise retraction and replacement;
- a normalized-text cache used by the versioned `neo:matchesText` function.

The RDF store is the semantic index. V1 evaluates text matching over candidate
`neo:content` literals selected by the RDF plan; token/trigram postings and a
hierarchy reachability cache are compatible future accelerators, not a second
query contract.

Every runtime revision records the graph ID and sorted Loro state frontier and
exposes projection/profile/analyzer version constants. Standalone projection
tests use the validated snapshot fingerprint as a deterministic frontier.
The current client does not persist the index: every open deterministically rebuilds it. A
future persisted cache must key all those versions and the Loro frontier and
fall back to this same rebuild path on any mismatch.

## Index Maintenance and Consistency

After each validated local or remote Loro change, `GraphRuntime` obtains one
immutable domain snapshot and reprojects it. The entity ledger computes the
semantic triple difference, and one store transaction retracts and inserts that
difference before the revision is published. This deliberately simple path
prioritizes correctness; field-level change sets can later avoid
reprojecting unchanged entities without changing query results.

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
         prop:builtin.task-status "todo" ;
         prop:builtin.task-deadline ?deadline ;
         neo:content ?content .
  FILTER (?deadline < ?today && neo:matchesText(?content, ?needle))
}
ORDER BY ?deadline ?block
LIMIT 100
```

A block is executable when it has `builtin.query-source: String`. New query blocks also write
`builtin.query-language: "sparql-1.1/neoseq-v1"`; a missing language uses that default.
Source and language synchronize as ordinary properties.
Plans, results, parameters, and editor state do not.

## Planning, Reactivity, and Budgets

Parsing produces diagnostics and SPARQL algebra. Oxigraph plans that algebra
over the RDF store. Typed bindings are injected as an algebraic `VALUES` row,
not source text. Execution never falls back to scanning Loro containers.

The client debounces query blocks and graph search. A canonical session
revision invalidates every visible query block; generation tokens discard stale
responses. Predicate-level dependency tracking is a future optimization and
must preserve this conservative invalidation behavior.

V1 limits source bytes, algebra operators, initial bindings, and output rows.
Request budgets may tighten but cannot raise the runtime ceilings. Budget failures
use a typed CorePort error and never return partial rows. Browser
evaluation runs in the graph Worker so it cannot occupy the UI thread. Elapsed
time, scan/intermediate-solution, path-depth, memory, and cooperative
cancellation budgets belong to production hardening before untrusted large
graphs are enabled.

## Verification

- Projection fixtures cover entity relations, all property types, repeated
  values, default predicates, dangling references, deletions, and tree moves.
- Rebuild tests compare semantic triples and frontier fingerprints after an
  incremental refresh and a clean construction.
- SPARQL tests cover typed bindings, custom text matching, stable ordering, and
  rejection of graph-producing, dataset, named-graph, and federated forms.
- Differential tests compare query rows from refreshed and clean indexes;
  native CorePort and browser E2E suites exercise the same public query shape.
- Budget tests prove typed failure before partial rows are returned.

## Upstream Basis

Syntax and algebra semantics follow the W3C
[SPARQL 1.1 Query Language Recommendation](https://www.w3.org/TR/sparql11-query/),
except for the explicitly restricted forms and the one versioned text function
above.
