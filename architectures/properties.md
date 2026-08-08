# Property Fields

This document defines the shared property model used by the domain, graph core,
CorePort snapshots, query projection, and clients.

## Field Model

A property bag is a key-unique collection of `PropertyField` values:

```text
PropertyField {
  key
  value_type
  cardinality: single | set
  values: PropertyValue[]
}
```

Field presence and value presence are independent. `values: []` is a present
property with no value; absence of the field means the property is not present.
There is no null, empty string, or synthetic `Empty` value. A single field has
zero or one value, while a set field has zero or more distinct values. Every
stored value must match the field's declared type and registry shape.

Known keys derive type, cardinality, placement, and write access from the
property registry. A newly created unknown `user.*` field records the shape
chosen by its command, after which that shape is stable. Unknown `builtin.*`
fields remain readable but are not generically writable.

## Owners and Commands

One `PropertyOwner` identifies every user-writable bag:

- page;
- block, including its owning page;
- tag default.

The same commands apply to every owner:

| Intent | Command | Result |
| --- | --- | --- |
| create an empty field | `ensure_property` | field exists with `values: []` |
| set a single value | `set_property` | field exists with one value |
| clear values | `clear_property_values` | field remains, values become empty |
| remove a field | `remove_property` | field and all values are absent |
| add a set member | `add_repeated_property` | member is present idempotently |
| remove a set member | `remove_repeated_property` | member is absent; field remains |

Target-specific validation is selected from the owner. Tag defaults do not
have a parallel command family or a special value representation. Commands are
one transaction and therefore preserve the existing undo, redo, persistence,
touch, and refresh boundaries.

## Tag Default Materialization

Adding a tag copies each default field whose key is absent from the target.
The complete shape and current values are copied, so an empty default creates an
empty property field on the page or block. A present empty field counts as an
existing field and is never overwritten by another default.

Defaults are materialized, not dynamically inherited. Removing a tag does not
remove copied fields, and later default changes are not retroactive.

## Storage and Projection

The Loro bag stores one stable field marker per key and separate stable value
slots. The marker owns the key, value type, and cardinality; it carries no
inline values. A field marker can therefore survive clearing its value slots.
Removing a property deletes both its marker and value slots. Snapshot decoding
joins markers and values and quarantines orphaned, malformed, or shape-invalid
slots.

The RDF projection emits a property-presence relation for every field and emits
the existing typed value predicate once per value. Empty fields consequently
remain queryable without inventing an RDF literal.

## Client Contract

Clients render an empty field as “No value” and keep it editable. The picker
offers separate actions to add without a value, clear values, and remove the
property. Specialized task and query renderers are optional views over the same
field; empty specialized fields remain reachable through the generic chip path.

During the pre-release v1 phase this model replaces the earlier entry-per-value
encoding in place. No schema-version bump or migration is provided: snapshots
written with the superseded encoding are intentionally incompatible and should
be discarded or recreated.
