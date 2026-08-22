# Property Fields and Documents

This document defines the shared property model used by the domain, graph core,
CorePort snapshots, query projection, and clients.

## Two Property Shapes

A property bag is a key-unique collection of `PropertyField` values. A field has
a stable marker containing its key, value type, and cardinality. Its value is
one of two shapes:

- an atomic single or set containing finite numbers, strings, page references,
  checkboxes, or local dates;
- a single schema-owned document whose internal CRDT containers define its
  merge granularity.

Atomic fields retain the v1 DTO shape:

```text
PropertyField { key, value_type, cardinality, values: PropertyValue[] }
```

Field presence and value presence are independent for atomic properties.
`values: []` is a present empty field; absence of the marker means the property
is absent. A single field has zero or one value and a set has distinct values.

A document snapshot is carried as one tagged `PropertyValue` across CorePort,
but it is not stored as one JSON value. It includes `schema` and `version` so
domain validation and the client renderer can dispatch without inspecting UI
implementation details. Generic atomic commands cannot write or clear document
properties; they may remove the complete field.

## Registry and Schema Ownership

[`../contracts/property-registry.json`](../contracts/property-registry.json)
defines shape, semantic ordering, placement, write access, and clipboard copy
policy. Portable fields cross an outline clipboard fragment; lifecycle fields
regenerate on the new node and deleted markers are omitted. Ordering is
separate from presentation: `choice_order` makes the declared string choices an
ordered domain while localized labels and picker placement remain client concerns.
Known built-ins have a compiled
domain schema. Unknown built-ins remain preserved and read-only; unknown
`user.*` fields remain atomic and editable with their command-selected shape.

Document schemas have coordinated handlers at existing boundaries:

- `domain` owns DTOs, validation, and semantic commands;
- `graph-core` owns the schema's Loro container layout and mutations;
- `query` explicitly chooses any semantic RDF projection;
- the client maps the schema to its renderer and editor.

The registry never stores React component names, CSS, icons, or localized copy.
An unknown future document version is preserved by the CRDT document and is not
generically editable by an older client.

## Task Keys

The task keys are ordinary registry entries; there is no task storage shape. Two of
them are worth stating explicitly because their split is a deliberate boundary rather
than an accident of history:

- a **moment** is a `date` key (`builtin.task-scheduled`, `builtin.task-deadline`) plus
  an optional string companion holding `HH:MM`
  (`builtin.task-scheduled-time`, `builtin.task-deadline-time`). The two are separate
  facts and separate commands. Keeping the day a `date` is what keeps it comparable as
  `xsd:date` in the derived index; folding a time into that literal would make every
  date comparison in a user query ill-typed;
- **recurrence** is `builtin.task-repeat`, a `<count><unit>` string the client
  interprets. Advancing a recurring task is a client behaviour composed of the ordinary
  property commands, not a domain verb: the domain validates the value as a string and
  states nothing about what recurring means.

A value either key cannot interpret stays readable and editable as the string it is,
which is the same tolerance every other unknown property value gets.

## Query Document

`builtin.query` is `neoseq.query` version 1. Its snapshot contains source,
language, an optional builder plan, stable-ID views with their column layout and
presentation options, and a default view ID. Its canonical Loro layout is:

```text
d:builtin.query: Map
  schema, version, language, default_view_id
  source: Text
  plan_version, plan          (optional; the builder's authoring payload)
  views: Map<QueryViewId, Map>
    name, kind, position, columns, options, deleted
```

Source edits use Unicode splice commands and merge as collaborative text. View
records merge independently by stable ID. Position ties sort by ID, making
concurrent inserts deterministic. Removing a view writes its `deleted` marker,
so edits to its other fields do not implicitly resurrect it; removing the
default selects the first remaining ordered view in the same transaction.

`plan` is the query builder's structured description of the same query, stored
beside the SPARQL it compiled to. The domain validates only that it is a bounded
JSON object carrying its own version; the authoring grammar belongs to the
client, and a version a reader does not understand simply leaves that block on
its source. Setting a plan writes it and its compiled source in one transaction,
and writing source by hand clears the plan, so a stored plan always describes
what runs.

`columns` is a per-view ordered list of `{variable, hidden, width}` records, and
`options` carries presentation switches (`compact`, `wrap`, and an optional
`sort` of `{variable, descending}`). Both decode leniently: a variable a view has
never seen stays visible at its natural position, an unreadable options record
falls back to defaults, and a switch a reader does not know is ignored rather
than rejected — which is what lets one replica add a switch without invalidating
the document for another. A `sort` naming a variable the view no longer lists is
valid and simply stops applying, so narrowing a query never makes its saved view
unreadable. The two views a document is born with are `table` and `list`; views a
reader creates carry generated IDs and their own names, and use the same record
contract rather than adding property keys or storage roots. A document holds
between one and thirty-two views.

## Owners and Commands

Page, block, tag, and tag-default bags share atomic property commands. Target
policy comes from the owner and registry. A tag owns two bags and they are
different targets: `tag` is the tag's own metadata — what the tag *is*, including
its query — and `tag_default` is what the tag copies onto whatever it is added
to. Document schemas add semantic commands; the query document currently supports
source set/splice, plan set/clear, view put/remove, and default-view selection.
One command remains one Loro transaction, undo item, durable update, and semantic
event. A write to either tag bag is a graph-scoped history effect, because a tag
belongs to no page.

Tag defaults materialize only schemas whose registry contract allows copying.
The query document has a tag-metadata placement and no tag-default placement: a
tag may ask a question of its own, and no tag copies a query onto a block.
Atomic defaults copy their complete marker and current values only when the
target key is absent; removing a tag or later changing its defaults is not
retroactive.

## Storage, Projection, and State Boundaries

Atomic fields use one marker plus separate single/set slots. Document fields use
one marker plus a schema-owned mergeable container. Snapshot decoding joins
them and quarantines malformed or contract-invalid data. Removing a field
deletes its marker and all atomic or document storage below that key.

RDF always emits property presence. Atomic values emit typed predicates.
Document values are not recursively converted to RDF; each schema must opt into
a bounded semantic projection so presentation settings do not pollute graph
semantics.

Saved query source, shared views, and the shared default view are graph data and
synchronize with the graph. Query results, revisions, loading state, selection,
scroll, and editor drafts are derived or session state and never synchronize.
User-private overrides such as a person's last-opened view belong to a separate
user preference sync unit when cross-device preference sync is introduced.

During pre-release development this contract replaces the earlier
`builtin.query-source` and `builtin.query-language` properties in place. No
migration or dual-read/write path is supported.
