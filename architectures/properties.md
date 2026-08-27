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

Client presentation policy keeps feature-owned fields out of generic property
surfaces. In particular, favourite and tag ordering remain writable only through
their ordering interactions; their numeric storage is not a second editor.

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

## Favourites

`builtin.favorite` is a checkbox on a page or on a tag — the two things a reader
navigates to. There is no favourites list: the flag lives on the thing itself, so
nothing has to be kept in step when one is deleted and two replicas starring the
same thing converge without a merge rule. It is graph data rather than a browser
preference, so a graph opened elsewhere keeps the handful of places worth
returning to.

`builtin.favorite-order` is the reader's own order for that list, and it is one
number on the same two owners — the same model `tag-order` uses, for the same
reason: positions are spaced so an ordinary move lands on the midpoint between
its new neighbours and writes only what moved, and an exhausted gap or a run
that has never been ordered respaces. Anything without a position sorts after
everything with one, by name, so starring something never reshuffles what is
already arranged. The order is graph data because the list is: an arrangement
that stayed in one browser would disagree with the favourites it arranges.

## Tag Identity Keys

`builtin.tag-group`, `builtin.tag-order`, `builtin.tag-color`, and
`builtin.tag-icon` are ordinary registry entries placed on `tag_metadata` and
nowhere else: they describe what a tag *is*, and no tag copies them onto a block.
There is no group entity — a group is the string its members carry, so it exists
because a tag is in it, disappears with its last member, and is renamed by
rewriting them. `tag-order` is one number carrying both orders: tags sort by it
inside a group, and a group sorts by the lowest one its members hold, because a
name has nowhere of its own to keep a rank. Positions are spaced so an ordinary
move lands on the midpoint between its new neighbours and writes only the tag it
moved; an exhausted gap respaces the run. The colour is one of the eight hue
names the accent itself offers rather than a colour, so presentation stays inside
the client's measured token set; the icon is one grapheme of text. An unreadable
value in any of the four degrades to "unset" rather than invalidating the tag.

## Query Document

`builtin.query` is `neoseq.query` version 2. It contains stable-ID views and a
default view ID. Each view owns both its executable definition and its
presentation. Its canonical Loro layout is:

```text
d:builtin.query: Map
  schema, version, default_view_id
  views: Map<QueryViewId, Map>
    name, kind, position, columns, options, deleted
    definition: Map
      language
      source: Text
      plan_version, plan      (optional; the builder's authoring payload)
```

Source edits name a view, use Unicode splice commands, and merge as collaborative
text within only that view. View records merge independently by stable ID; no
definition write reads or rewrites a sibling view. Position ties sort by ID,
making concurrent inserts deterministic. Removing a view writes its `deleted`
marker, so edits to its other fields do not implicitly resurrect it; removing
the default selects the first remaining ordered view in the same transaction.

`plan` is the query builder's structured description of one view's query, stored
beside that view's compiled SPARQL. The domain validates only that it is a bounded
JSON object carrying its own version; the authoring grammar belongs to the
client, and a version a reader does not understand simply leaves that block on
its source. Setting a plan writes it and its compiled source in one transaction,
and writing source by hand clears the plan, so a stored plan always describes
what runs in that view. Version 1 documents migrate by copying their single
definition into every existing view; subsequent writes are independent.

`columns` is a table-only per-view ordered list of `{variable, hidden, width}`
records. `options` carries common density, table wrapping, a table `sort` of
`{variable, descending}`, and a block-list `list_sort` of
`{field, descending}`. List fields use stable IDs from the builder's condition
vocabulary rather than table variables. These records decode leniently: a
variable a table has never seen stays visible at its natural position, absent or
unreadable options fall back to defaults, and an unknown sort term simply stops
applying. A document is born with one view, `all`, drawn as a table: layout is a
field of a view rather than a second view, so two views are two questions. Views
a reader creates carry generated IDs and their own names, and use the same record
contract rather than adding property keys or storage roots. A document holds
between one and thirty-two views, ordered by `position`.

## Owners and Commands

Page, block, tag, and tag-default bags share atomic property commands. Target
policy comes from the owner and registry. A tag owns two bags and they are
different targets: `tag` is the tag's own metadata — what the tag *is*, including
its query — and `tag_default` is what the tag copies onto whatever it is added
to. Document schemas add semantic commands; the query document currently supports
source set/splice, plan set/clear, view put/remove, and default-view selection.
One user intent remains one Loro transaction, undo item, durable update, and
semantic event. A bounded, flat `batch` command composes ordinary commands when
one intent crosses property or entity boundaries; it validates every step on a
disposable fork before canonical state changes. History commands and nested
batches are forbidden. A write to either tag bag is a graph-scoped history
effect, because a tag belongs to no page.

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

Saved query definitions, views, and the shared default view are graph data and
synchronize with the graph. Query results, revisions, loading state, selection,
scroll, and editor drafts are derived or session state and never synchronize.
User-private overrides such as a person's last-opened view belong to a separate
user preference sync unit when cross-device preference sync is introduced.

During pre-release development this contract replaces the earlier
`builtin.query-source` and `builtin.query-language` properties in place. No
migration or dual-read/write path is supported.
