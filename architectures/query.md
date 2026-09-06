# Query and Derived Index Architecture

## Goals and Boundary

Loro is the only source of truth for graph content. Query, search, task views,
backlinks, and future graph-wide projections execute against a per-graph derived
RDF index; they never walk `LoroDoc` as their normal read path. The complete
index is reproducible from a validated Loro snapshot, so losing or deleting it
cannot lose user data.

Neoseq has two explicit authored query forms: the product's typed `QueryPlan`
and raw read-only SPARQL 1.1. Both lower once at the Rust boundary into the same
`LogicalQuery` algebra. Queries run only in the client Rust core. They cannot
mutate CRDT state, select another graph, contact a SPARQL endpoint, or access
platform I/O.

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

| Loro/domain value             | RDF projection                                                                                                             |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| live page                     | `rdf:type neo:Page`, `neo:content`                                                                                         |
| live block                    | `rdf:type neo:Block`, `neo:content`, `neo:owner`, `neo:parent`, `neo:siblingIndex`; page-owned blocks also have `neo:page` |
| live tag                      | `rdf:type neo:Tag`, `neo:name`                                                                                             |
| node tag reference            | `neo:tag <tag-entity-IRI>`                                                                                                 |
| block page reference          | `neo:references <page-entity-IRI>`                                                                                         |
| entity property field `k`     | `<subject> neo:hasProperty <property-key-IRI>`                                                                             |
| page/block property `k = v`   | `<subject> prop:<encoded-k> <typed-v>`                                                                                     |
| tag metadata property `k = v` | `<tag> prop:<encoded-k> <typed-v>`                                                                                         |
| tag default field `k`         | `<tag> neo:hasDefaultProperty <property-key-IRI>`                                                                          |
| tag default `k = v`           | `<tag> def:<encoded-k> <typed-v>`                                                                                          |

A root block's parent and `neo:owner` are its page or tag IRI; other blocks point
to their parent block while retaining the same owner. `neo:page` remains on
page-owned blocks for compatible fast page scoping and is absent from tag-owned
blocks. Sibling indexes are zero-based `xsd:integer` values derived from the current visible tree order.
Standard property paths such as `neo:parent+` express ancestry; a private reachability
accelerator may optimize them without changing the RDF projection.

Property values map without heuristic parsing: numbers to `xsd:double`, strings
to `xsd:string`, checkboxes to `xsd:boolean`, local dates to `xsd:date`, and page
references to page entity IRIs. Repeated values emit repeated predicates; equal
values naturally collapse under RDF set semantics, matching the source model's
idempotent member identity. A dangling page or tag reference remains an object
IRI even when no live subject describes it.
An empty field emits only its presence relation and no value predicate.

Block `neo:content` materializes page-reference atoms with the current page
title. A rename invalidates the disposable projection so dependent literals and
text postings refresh together without rewriting Loro. `neo:references` is the
stable boundary for an incremental reverse ledger when measurements justify it.

Soft-deleted entities and blocks hidden by a deleted page or tag are absent from the
default projection. Tombstone resolution remains a core read concern rather
than implicit SPARQL filtering. Quarantined values never enter the index.

The RDF mapping, vocabulary, property-IRI encoding, Unicode normalization, and
text analyzer are covered by checked-in conformance fixtures. Changing an
observable mapping requires a corresponding profile or projection version.

## Physical Index

Each open graph owns an Oxigraph in-memory store backed by:

- an RDF-term dictionary and the store's triple permutations;
- Oxigraph's optimizer and evaluator, plus its parser for raw SPARQL only;
- a compact outline-owner-to-entity-subject ledger for targeted retraction;
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
The current client does not persist the index. A recovered graph begins with a
cold derived-index state; its first query deterministically builds at the current
canonical frontier. Commands and remote imports may proceed while the index is
cold because the eventual build reads the then-current document. Once ready,
the index consumes the same incremental deltas as before. Cold construction
streams one complete page or tag publication unit at a time from Loro into a
bounded Oxigraph bulk loader. It does not materialize a complete domain snapshot,
graph-wide projection, or duplicate triple ledger. A future persisted cache must
key all profile versions and the Loro frontier and fall back to this same
streaming rebuild path on any mismatch.

## Index Maintenance and Consistency

Each validated local command or remote import produces a projection change set
from its committed Loro diffs. Pages and tags are the publication units. A page
replacement includes its complete visible block tree because structural edits
can change parent and sibling-index triples beyond the directly targeted block.
The change set is either `Incremental` or `Rebuild`; partial IDs cannot coexist
with a rebuild flag. An incremental index delta is keyed by publication-unit ID
and gives each unit exactly one state: upserted or removed.
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

CorePort v5 makes authorship explicit rather than accepting two fields that can
disagree:

```text
query(graph_handle, {
  kind: "built", plan: QueryPlan v2, today, budget
} | {
  kind: "raw_sparql", language: "sparql-1.1/neoseq-v1",
  source, bindings: Map<Variable, RdfTerm>, budget
}) -> QueryResult (built | select | ask)
```

The built compiler validates the complete plan grammar and constructs algebra
directly; it never serializes or parses SPARQL. `today` resolves relative dates
at execution. A plan declares its result grain independently of its renderer:

- `entity` selects distinct subject identities in stable order, applies the
  limit, then reads each selected entity's fields from the same index revision.
  Repeated fields are typed value vectors; adding a column cannot multiply rows,
  remove entities, or change which entities survive the limit.
- `summary` groups explicit fields and requires at least one `count`, `sum`,
  `avg`, `min`, or `max` aggregate. Its rows carry no editable subject identity.

There is no independent distinct flag or list aggregate in v2. Raw bindings become the query's
initial solution mapping and are never inserted through string substitution.
A select result preserves declared variable order and returns unbound, IRI, or
typed-literal cells plus index revision/frontier. Entity IRIs are additionally
decoded to typed entity references at the CorePort boundary.
A built answer instead carries a descriptor and rows with explicit subject
references and typed value vectors keyed by authored column ID. The descriptor
contains the subject kind, grain, column sources, authored labels, aggregates,
and moment companions. Compiler variables and string separators are private;
the client never reconstructs column meaning from their spelling.

For example, a hand-authored raw request may bind `?today` and `?needle` as typed
values:

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

A query view in a valid `builtin.query` document (`neoseq.query` version 2)
owns either a builder plan or hand-authored source, plus its column and
presentation layout. Built versus Raw is one atomic register. A Built plan is
the sole authored authority, and the Rust core regenerates its marked source as
an inspectable explanation; that artifact
is not independently executable because operands may remain parameterized. A
plan version this build cannot understand stays visibly unavailable rather than
silently running the explanation as raw SPARQL. Existing v1 plans remain opaque,
read-only data with their payload and any source preserved. Their source may be
empty; they are not reinterpreted as v2 because their previous grain depended on
the renderer. Only ordering and the default
view are document-wide. Table and list are the current renderers.

Blocks, pages, and tags may own one. A tag's is the tag's own view of the graph
it names, and the client seeds it rather than writing it: opening a tag runs a
plan derived from the tag and touches nothing, and the first edit — a condition,
a column, a second view — is what brings the document into existence. Once
written it is an ordinary query document with no privileged conditions, so a
reader may narrow it, widen it, or point it somewhere else entirely.

A view keeps renderer-specific ordering, and each order is a bounded list of at
most eight distinct terms, most significant first. A table term names a projected
authored column ID, or a variable for raw SPARQL. A block-list term names a stable field from the builder's
condition vocabulary, including graph-visible properties, so filtering and list
ordering cannot offer different fields. Unknown or no-longer-applicable terms
remain readable and simply stop applying. Table deserialization also accepts the
single-object form earlier builds wrote as a one-term list.

Which columns a table _shows_ is held per view as a hidden flag beside each
column's width and place. A block list has no columns: it resolves each result
subject to its canonical `BlockSnapshot` and draws the block's inline grammar —
Markdown, task marks, tags, and generic property chips. Result cells never become
supplemental block facts, and a table's hidden or selected columns cannot change
the list. Children and embedded feature surfaces do not render through the
reference; feature-only properties such as `builtin.query` are therefore neither
chips nor recursively mounted queries. Summary, raw, and non-block results
use a generic list over the same returned rows and columns.

The active view's columns describe its entity fields or summary. Sibling views
never participate in a column edit. Table and List execute the identical authored
request and preserve its result grain; changing layout never changes the question.

Every plan-carrying view is built. A view with no plan still runs and reads from
its source, but the client offers no builder for it.

A graph may also own query documents directly. Its _standing questions_ — the
answers today's journal opens with — live under `graph_settings.default_queries`,
synchronize with the graph, and use the same document shape as entity queries.
`QueryOwner` keeps this ownership explicit: entity variants resolve through
`builtin.query`, while `graph_default` resolves to the settings entry. The client
keeps that identity separate from a query surface's role. A managed surface may
author the plan and manage the collection of saved views; a presented surface
may only shape the current saved view. Settings is the standing question's
managed author, while the journal presents it with the same `graph_default`
owner and may persist layout, sort, and table column presentation through
`put_query_view`. Result editing is unaffected: a row still names a block in
this graph, and writing it remains an ordinary property command.

A plan draft retains the saved payload it was based on. Incoming saved plans
replace a clean draft; they cannot overwrite newer unsaved input in the same
view. When persistence catches up, the draft becomes clean and follows later
remote edits again. Switching views adopts that view's own definition.

Ordering semantics are derived rather than stored. The selected field and the
property registry resolve to one semantic order: declared choices use their
stored-value rank, numbers and dates use typed value order, references use their
resolved label, and ordinary text uses text collation. Rendering is a separate
projection, so a translated label cannot change a ranked order. A table compares
typed value vectors. A block list first hydrates result owners and compares values
from canonical block snapshots; repeated fields compare as semantically sorted
vectors. Missing values remain last in either direction except task priority,
where absence is the rank below Low. Equal rows use stable entity identity as the
final tie-breaker.

Scheduled and deadline ordering compares the date, then its companion time of
day, before applying the next sort term. Missing or invalid times remain last
within the same date in either direction. Tables use the result descriptor's
time companion; block lists read it from the canonical property bag.

The compiled plan carries no order of its own beyond the subject, which is what
a `LIMIT` cuts against: renderer ordering rearranges only the answer already
returned. A product question that needs ordering to choose which rows survive a
limit must express that semantic order in the authored query instead.

The RDF projection emits the query property's presence but does not recursively
project its document configuration. Query plans (in the SPARQL planner's sense),
results, runtime bindings, revisions, loading/error state, private view
overrides, answer folding, and editor drafts do not synchronize.

Conditions disclosure belongs to each saved view's shared presentation options.
An explicit open or closed value is stored in Loro and follows the document
through synchronization, archives, reloads, and undo/redo. If no value has been
set, the surface supplies its initial default; an explicit closed value always
wins, even for a question with no conditions. A read-only graph permits temporary
local inspection without writing a shared preference.

Default queries use that same view option in Settings and on the journal. The
journal can disclose the conditions for inspection; Settings retains authority
to edit their definition. Opening the conditions never grants authoring authority.

Answer folding remains a browser-local reading preference, stored as a bounded
list of folded execution keys per graph.

## Editable Result Projection

Table presentation consumes the answer's columns and rows directly. Visibility,
ordering, and transient resize state belong to the query view; no second table
row or cell model reinterprets the answer.

Query evaluation remains read-only. A builder-authored block result can be
edited only when the executed answer declares entity grain and its column
descriptor names a direct block field. The client combines the row's explicit subject,
the descriptor, the property registry, and the current writable lease
into an ephemeral edit binding. It never infers a write target from a variable
name, RDF datatype, or displayed value.

Direct block content writes semantic content splices; direct writable properties use
the owner-based property commands; tag collections use `add_tag` and
`remove_tag`. Summary rows, structural relations,
unknown plan versions, and raw results remain read-only. SPARQL Update is
not introduced.

RDF rows are display data rather than edit baselines. An editor reads its
subject's canonical `BlockSnapshot`, hydrating its outline owner as needed.
Content projections hydrate the distinct result owners to resolve stable
page-reference spans. A block list uses those same canonical snapshots to
render each block through the outline's presentation primitives. Direct block
fields use the native block presentation.
Selected aggregates and structural relations remain table cells rather than
block facts. Plan-less and non-block results may use generic result cells.
Embedded feature surfaces and children do not render through a result reference.

The outline and query surfaces share block presentation and the content-editing
kernel described in [Block editing](block-editing.md), but retain separate
structural controllers. Pairing, IME repair, `/` and `#` completions, document
history, and entity commands therefore have one behavior. Outline focus,
selection, dragging, structure, presence, and pending rows remain outline-owned;
query navigation and stale-row pinning remain query-owned. One query-level
coordinator binds the graph-scoped content session across Table/List presentation changes,
keeps identity by entity and field rather than row position, and pins an active
row if its write makes the row stop matching. The row leaves after the editor
closes. A failed write keeps its draft and an in-place retry route.

Changing an authored result descriptor or selecting another saved view first
settles the active content edit. A rejected edit keeps the old surface available.
If a remote question produces a different descriptor while editing, the complete
previous answer frame remains displayed until that editor closes. Membership-only
refreshes still update normally and may pin the active row.

Writable plain content uses one textarea before and after focus, so a pointer
press places the native caret and starts editing in the same interaction.
Rendered Markdown uses the outline's preview-to-source caret hand-off. Links
remain navigable in both table and list projections, with a separate control to
open the block. Explicit block navigation reveals the destination with a brief
accent pulse, or a stationary highlight when reduced motion is preferred. A
cross-owner result stays read-only only while its canonical block hydrates; the
input element itself remains stable.

Canonical mutations publish the next index revision and conservatively rerun
visible queries. Page hydration has a separate snapshot revision and does not
invalidate query results by itself.

## Authoring: the Query Builder

A **query plan** is the product builder's typed authored representation: a
subject kind, a nested all/any/none tree of typed conditions, explicit entity or
summary grain, output fields, and a bounded integer row limit. Entity values
preserve their cardinality without aggregation. Summary authoring owns grouping
and scalar aggregation. The generated CorePort types and
the Rust `query` crate describe the same versioned grammar.

When a view carries a plan, that plan is its sole authority. The browser sends
`Built(plan)` and the Rust query compiler validates and lowers it directly into
`LogicalQuery`; no SPARQL text is produced, transferred, parsed, or trusted on
that execution path. `RawSparql(source)` is a separate authored alternative for
legacy and hand-authored documents. Both converge before sandbox validation,
physical planning, and evaluation, so there is one execution representation.

The source text beside a Built plan is deliberately inert. The Rust core
regenerates the provenance-marked explanation during projection, so
caller-supplied or concurrently edited text is never trusted beside a valid
plan. The browser only displays this artifact; it has no query semantics
compiler. Explicitly setting raw source replaces that text and atomically
selects Raw; incremental source edits cannot eject a Built plan. An unsupported
plan version retains the plan and its inert source for inspection, but executes
neither.

Rust differential tests compare direct lowering with representative legacy
SPARQL artifacts. Three lowering properties are contractual:

- User values become typed algebra terms, never syntax fragments. A relative
  operand resolves from the request's validated local date on every execution.
- Negation is `NOT EXISTS` over the positive pattern, so "does not contain"
  keeps entities that carry no such value at all.
- Alternatives are a disjunction of correlated `EXISTS`, not `UNION`, so each
  branch asks its question of the subject already in hand.

Entity selection and field projection are separate stages at one index frontier.
Summary grouping belongs to its explicit algebra; it cannot be introduced by a
table display field or removed by switching to List.

## Planning, Reactivity, and Budgets

Built plans construct logical algebra directly; only raw SPARQL is parsed for
syntax diagnostics. Oxigraph plans the common algebra over the RDF store. Raw
typed bindings are injected as an algebraic `VALUES` row, not source text.
Execution never falls back to scanning Loro containers.

The client treats a mounted query as a demand read: activation runs immediately,
while changes to its authored request or canonical session revision are
debounced. A bounded per-session result cache lets route and virtualized-row
remounts paint a current answer synchronously and deduplicates identical work.
One answer frame retains the executed request, its result descriptor and rows,
and the canonical session revision captured when execution begins in the command
queue. The scheduling revision never labels the answer. A stale frame remains
visible while its replacement runs and is interpreted solely by its own
descriptor; a newer draft cannot relabel its fields or grant editing authority.
Request identity and execution tokens prevent superseded work from replacing it.
Predicate-level dependency tracking is a future optimization and must preserve
this conservative invalidation behavior.

The query boundary limits authored bytes, algebra operators, raw initial
bindings, output rows, values, and result bytes.
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
