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
- a compact page-to-entity-subject ledger for targeted retraction;
- a normalized-text cache and compressed trigram postings used by the versioned
  `neo:matchesText` function;
- compressed exact-property postings and typed ordered property values used for
  bounded candidate selection.

The RDF store remains the semantic index. The planner recognizes only algebra
shapes whose restriction is provably equivalent: mandatory text/range/equality
conditions become compressed candidate intersections, and a simple ordered
entity query may evaluate its bounded top candidates against a temporary RDF
dataset. Oxigraph still evaluates the complete query and therefore remains the
semantic verifier. Unsupported or ambiguous shapes fall back to the complete
RDF store. A hierarchy reachability cache remains a compatible future
accelerator, not a second query contract.

Every runtime revision records the graph ID and sorted Loro state frontier and
exposes projection/profile/analyzer version constants. Standalone projection
tests use the validated snapshot fingerprint as a deterministic frontier.
The current client does not persist the index: every open deterministically
rebuilds it. Cold construction streams validated tags and one complete page at
a time from Loro into a bounded Oxigraph bulk loader. It does not materialize a
complete domain snapshot, graph-wide projection, or duplicate triple ledger.
A future persisted cache must key all profile versions and the Loro frontier
and fall back to this same streaming rebuild path on any mismatch.

## Index Maintenance and Consistency

Each validated local command or remote import produces a projection change set
from its committed Loro diffs. Pages and tags are the publication units. A page
replacement includes its complete visible block tree because structural edits
can change parent and sibling-index triples beyond the directly targeted block.
The runtime materializes snapshots only for the named units, reprojects those
units, reads their previous outgoing triples through the RDF subject index, and
atomically retracts and inserts their entity-level triple differences. Text and
property postings use the same page/tag publication boundary and are updated
with the RDF store. Their dense identifiers are private to one in-memory index
revision and never become entity identity.

Diffs that cannot be classified safely trigger the complete snapshot rebuild
path. Full reprojection is therefore a recovery path, not the normal edit or
sync path. The initial build, full fallback, and single-page delta are measured
separately so regression tests preserve both correctness and edit-time scaling.

A query sees exactly one published revision. It may continue on the prior
revision while the next one is built, but never observes a partial delta. The
revision carries its Loro frontier, and query results report both revision and
frontier so callers can reject stale work. If delta application fails, the
runtime replaces the derived index from the current validated snapshot rather
than publishing a partial delta. Index recovery never mutates canonical Loro
data.

## SPARQL Profile and API

V1 identifies its language as `sparql-1.1/neoseq-v1`. It supports `SELECT` and
`ASK` with basic graph patterns, `FILTER`, `BIND`, `VALUES`, `OPTIONAL`, `UNION`,
`MINUS`, `EXISTS`, subqueries, aggregates, grouping, ordering, distinct,
pagination, and property paths. `CONSTRUCT`, `DESCRIBE`, dataset clauses,
`GRAPH`, `SERVICE`, SPARQL Update, and implementation-defined extension loading
are rejected before planning. This fixes one local default graph and prevents
I/O or mutation by construction. Evaluation uses simple entailment only; the
runtime does not infer additional RDF, RDFS, or OWL triples.

Normalized content search uses the sole v1 extension function
`neo:matchesText(?content, ?needle)`. The first argument must be the object of an
`neo:content` or `neo:name` pattern and the needle must be a literal or a bound
literal parameter. The core validates this shape before planning so postings
cannot change its meaning. Its normalization and matching rules are part of the
analyzer-version fixture. All other expressions follow SPARQL 1.1 semantics.

The versioned core boundary is:

```text
query(graph_handle, {
  language: "sparql-1.1/neoseq-v1",
  source,
  bindings: Map<Variable, RdfTerm>,
  budget
}) -> QueryResult (select | ask)
```

Bindings become the query's initial solution mapping; they are never inserted
through string substitution. A select result preserves declared variable order
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

A block is executable when it has a valid `builtin.query` document with schema
`neoseq.query` version 1. Its source is collaborative text; language, the
builder plan behind it, stable-ID saved views with their column layout, and the
shared default view synchronize inside the graph. Table and list are the current
renderers.

A view's ordering is a bounded list of distinct result variables, most
significant term first, and the domain validates it as one: at most eight terms,
each naming a variable within the same bounds a column selection is held to, and
no variable twice. Presentation, not semantics — it reorders rows the query has
already returned, so a term is allowed to name a variable the view no longer
lists and simply stops applying. Deserialization accepts the single-object form
earlier builds wrote as a one-term list, so an order a reader saved then still
applies after the upgrade. A document with no plan is the hand-written kind:
there is no command that converts a planned query into one, only a separate
route that creates one.

Column ordering is derived rather than stored in a view. The plan's column
source and the property registry resolve to one semantic order: declared choices
use their stored-value rank, numbers and dates use typed value order, references
use their resolved label, and ordinary text uses text collation. Rendering is a
separate projection, so a translated label cannot change a ranked order. The
builder compiles the same semantics into `ORDER BY` before `LIMIT`; after
execution, the query result projection compares raw terms once and hands the
same ordered rows to Table and List. Both paths keep unknown choices behind the
declared domain. Unbound values remain last except task priority, where absence
is the rank below Low. Folded lists have no defined member order and are not
sortable.

The RDF projection emits the query property's presence but does not recursively
project its document configuration. Query plans (in the SPARQL planner's sense),
results, runtime bindings, revisions, loading/error state, private view
overrides, whether the editor or result is open, and editor drafts do not
synchronize. Result disclosure has graph-session lifetime: it survives route and
virtualized-row remounts for one reader, but a new session starts expanded.

## Editable Result Projection

Query evaluation remains read-only. A builder-authored block result can be
edited only when its compiled plan carries a stable subject variable and its
column provenance names a direct block field. The client combines that subject,
the plan's column source, the property registry, and the current writable lease
into an ephemeral edit binding. It never infers a write target from a variable
name, RDF datatype, or displayed value.

Direct block content writes `splice_markdown`; direct writable properties use
the owner-based property commands; tag collections use `add_tag` and
`remove_tag`. Aggregates other than a complete list, structural relations,
unknown plan versions, and hand-written SPARQL results remain read-only. SPARQL
Update is not introduced.

RDF rows are display data rather than edit baselines. Entering an editor lazily
hydrates the subject's canonical page and reads its `BlockSnapshot`; only the
active table result pays that cost. A block list is an entity projection: it
deduplicates and hydrates the result subjects' pages as one session operation, then
renders canonical block snapshots through the same presentation primitives as
the outline. Direct block fields use the native block presentation; selected
aggregates and structural relations remain supplemental query facts. Embedded
feature surfaces and children do not render through a result reference.

The outline and query surfaces share block presentation and the content-editing
kernel described in [Block editing](block-editing.md), but retain separate
structural controllers. Pairing, IME repair, `/` and `#` completions, document
history, and entity commands therefore have one behavior. Outline focus,
selection, dragging, structure, presence, and pending rows remain outline-owned;
query navigation and stale-row pinning remain query-owned. One query-level
coordinator owns a canonical draft across Table/List presentation changes,
keeps identity by entity and field rather than row position, and pins an active
row if its write makes the row stop matching. The row leaves after the editor
closes. A failed write keeps its draft and an in-place retry route.

Writable plain content uses one textarea before and after focus, so a pointer
press places the native caret and starts editing in the same interaction.
Rendered Markdown uses the outline's preview-to-source caret hand-off. A
cross-page result stays read-only only while its canonical block hydrates; the
input element itself remains stable.

Canonical mutations publish the next index revision and conservatively rerun
visible queries. Page hydration has a separate snapshot revision and does not
invalidate query results by itself.

## Authoring: the Query Builder

SPARQL stays the only executable query language, and the core reads nothing
else. A **query plan** is the *authoring* representation the client's query
builder writes that SPARQL from: a subject kind, a nested all/any/none tree of
typed conditions, output columns with optional aggregates, an order, and a row
limit. It is stored beside the source in the same document so reopening a query
reopens the builder rather than a wall of SPARQL, and so it reaches every
replica.

The split of ownership is deliberate. The domain owns whether a plan is
*well-formed* — a bounded JSON object carrying its own version — and enforces
that setting a plan writes it and its compiled source in one transaction, and
that writing source by hand clears the plan. The client owns the authoring
grammar and its compiler, because a builder is an editor for the source, and
the source it produces is validated, planned, and budgeted by exactly the same
path a hand-written query takes. A plan version a reader does not understand
leaves the block on its source, which still runs.

Three properties of the emitted SPARQL are contractual rather than incidental:

- **Every user value leaves as a bound parameter**, never as text spliced into
  the source. A plan therefore cannot inject syntax, and a relative operand
  ("due today") resolves against the reader's own today at run time instead of
  being frozen into the stored query.
- **Negation is `NOT EXISTS` over the positive pattern**, so "does not contain"
  keeps entities that carry no such value at all, which is the reading a person
  means.
- **Alternatives are a disjunction of `EXISTS`, not `UNION`.** A `UNION` branch
  is evaluated on its own and only then joined, so neither the subject nor any
  bound parameter is visible inside it — the branch would ask its question of
  the whole graph, and a parameterized branch would silently answer nothing.
  `EXISTS` is evaluated against the solution in hand, which is what "any of
  these is true *of this row*" means.

A repeated relation folded into one cell compiles to `GROUP_CONCAT` with the
remaining columns in `GROUP BY`. All of these shapes are covered by a
query-crate conformance test, because the compiler that writes them lives
outside Rust.

## Planning, Reactivity, and Budgets

Parsing produces diagnostics and SPARQL algebra. Oxigraph plans that algebra
over the RDF store. Typed bindings are injected as an algebraic `VALUES` row,
not source text. Execution never falls back to scanning Loro containers.

The client treats a mounted query as a demand read: activation runs immediately,
while changes to its source, bindings, or canonical session revision are
debounced. A bounded per-session result cache lets route and virtualized-row
remounts paint a current answer synchronously and deduplicates identical work;
signature and revision tags prevent obsolete responses from replacing it.
Predicate-level dependency tracking is a future optimization and must preserve
this conservative invalidation behavior.

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
- Rebuild tests compare semantic triples and frontier fingerprints after page
  and tag deltas, entity retractions, and clean construction.
- SPARQL tests cover typed bindings, custom text matching, stable ordering, and
  rejection of graph-producing, dataset, named-graph, and federated forms.
- Differential tests compare query rows from incrementally updated and clean indexes;
  native CorePort and browser E2E suites exercise the same public query shape.
- Budget tests prove typed failure before partial rows are returned.

## Upstream Basis

Syntax and algebra semantics follow the W3C
[SPARQL 1.1 Query Language Recommendation](https://www.w3.org/TR/sparql11-query/),
except for the explicitly restricted forms and the one versioned text function
above.
