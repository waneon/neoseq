# Property Command Picker Architecture

## Status and Scope

This document describes the shipped Web-client architecture for the
[Property Command Picker specification](../specs/property-command-picker.md).
It replaces the expanded page and block property forms with inline snapshot
projections and one contextual picker.

The change is client-side only. It does not change the graph schema, property
registry, CorePort contract, CRDT encoding, or domain command set.

## Architectural Decision

Every property entry route resolves one stable page or block target and opens
the same `PropertyPicker`. The picker owns only transient navigation and input
state. Canonical properties remain in immutable session snapshots, and every
mutation travels through `GraphSession.execute`.

```mermaid
flowchart LR
    Slash[Block slash menu] --> Outline[Outliner target]
    Shortcut[Contextual Mod+P] --> Bridge[Command bridge]
    Menu[Page or block menu] --> Target[Resolved target]
    Row[Inline property row] --> Target
    Bridge --> Target
    Outline --> Target
    Target --> Picker[PropertyPicker]
    Picker --> Registry[Registry and validation]
    Picker --> Session[GraphSession.execute]
    Session --> Core[CorePort and Rust core]
    Core --> Snapshot[Refreshed snapshot]
    Snapshot --> Rows[Inline property rows]
```

## Ownership Boundaries

### Outline and Slash Commands

`features/outline/Outliner.tsx` owns slash detection because it owns block
drafts, carets, IME composition, and pending-block reconciliation.

Detection is a pure scan of the current whitespace-delimited token at a
collapsed caret. A token beginning with `/` opens the slash menu when its query
matches the localized property command or its stable aliases. Detection never
changes Markdown.

The slash menu keeps focus in the textarea and offers `Add property` in this
release. `Escape` dismisses it without changing the draft. `Enter` removes the
recognized token and opens the property picker. A persisted block flushes
through the normal Markdown draft path first.

Pending blocks do not cross into the picker under temporary IDs. The outliner
remembers the property intent, waits for `insert_block` to return the real
`BlockId`, transfers raced text through the existing pending-row path, and only
then opens the picker. Insert failure uses the existing pending-insert report
and never opens a picker for a missing target.

### Command Bridge and `Mod+P`

`features/commands/shortcuts.ts` owns the default `Mod+P` binding. The shell
removes it from the general browser-reserved set but claims it only if
`CommandBridge.requestProperties()` reports an available target. Without a
registered page or block handler the event is not prevented, so the browser
retains Print.

The outliner registers the focused persisted block. `PageProperties` registers
the mounted page. The bridge gives a block handler precedence and otherwise
uses the page handler. Pending blocks do not register.

Pointer routes resolve explicitly:

- a property row supplies its owner, key, and row element;
- the block menu supplies its block and textarea;
- the page menu opens a fresh page-level property search; and
- the separate block `Tags` menu opens `TagPicker`, never `PropertyPicker`.

Once opened, a picker request contains stable IDs and cannot be retargeted by a
later focus change.

### Property Picker

`features/properties/PropertyPicker.tsx` owns three transient stages:

```text
property search -> optional custom type -> value edit
```

An existing row starts at value edit. A known registry key carries its declared
type and cardinality. A valid unknown `user.*` key requires an explicit value
type and is single-valued under current client rules. Unknown `builtin.*` keys
remain visible for forward compatibility but are read-only. Moving between
stages writes nothing.

Property candidates are bounded to:

1. generic-visible keys already present on the target;
2. registry definitions that are user-writable on the resolved target; and
3. one validated custom-key creation result for the current query.

Existing keys sort first. The picker does not scan the graph document or any
adapter-owned state.

Value controls are selected from the property type and definition:

- allowed strings and checkboxes use explicit choice rows;
- strings and numbers use text inputs with explicit commit;
- dates use the native date input;
- pages reuse `PageAutocomplete`; and
- repeated values show individually removable members plus whole-key clear.

The picker is portaled to `document.body` and positioned in viewport space from
the invoking element. This avoids clipping by the scroll container and the
virtualizer's transformed rows. Outside press, `Escape`, or a successful command
closes it. Closing restores focus to the invoking element when it still exists.

### Property and Tag Presentation

`PropertyRows` is the stateless block projection. Pages retain their compact
four-item `key: value` strip. Both use the client presentation registry to show
generic and feature-enhanced properties, format page references against the
current snapshot, and invoke the picker for direct editing. Read-only metadata
and hidden lifecycle fields never enter the generic route. Keys use the
identifier voice; values truncate without changing stored data. An empty bag
renders no rows or strip.

The legacy `PropertyBagEditor` and block inspector are removed. Tag membership
now lives in `TagPicker`, which reuses `TagChips` and `PageAutocomplete` while
continuing to issue `add_tag` and `remove_tag` commands.

Task and query projections remain views over well-known properties. Generic
property rows stay available as their consistent edit route.

## Command Mapping

The picker maps user intent onto the existing domain commands:

| User intent                   | Core command               |
| ----------------------------- | -------------------------- |
| Set or replace a single value | `set_property`             |
| Clear a single key            | `remove_property`          |
| Add a repeated member         | `add_repeated_property`    |
| Remove a repeated member      | `remove_repeated_property` |

The existing `builtin.query-source` orchestration remains: a successful source write
also materializes the default `builtin.query-language` when absent. This still uses a
second ordinary core command; no batch command or schema change is introduced.

## Snapshot and Lifecycle Rules

- Targets and bags are derived from `SessionState.snapshot` on every render.
- The picker never mutates a snapshot or renders an optimistic property row.
- Session reconciliation refreshes the owning page before the new row appears.
- If the target leaves the current page, the outliner can no longer resolve it
  and therefore unmounts the picker.
- Page and block pickers are owned by their routed view and disappear with it.
- Read-only state keeps rows readable and disables mutation actions.

## Validation and Failure Reporting

The current domain contract supplies only composed value shapes and target
placements to `entities/properties.ts`; all type, cardinality, string-choice,
write, and default checks are derived from them. Generic/hidden presentation is
also derived from placements, while sparse client-owned feature and metadata
renderer sets provide the exceptional rendering paths.
Keys outside `builtin.*` and `user.*`, malformed two-level keys, and core-managed
built-ins fail in the active stage; target, date, number, length,
restricted-string, and cardinality checks run before dispatch. The core repeats
all semantic checks and remains authoritative.

A rejected session command keeps the active picker state and reports once
through `features/notify/`. No failed mutation creates a row. Local durability,
retry, and save-state behavior remain owned by `GraphSession` and its adapter.

## Accessibility and Localization

- Property search is a combobox with an active-descendant listbox.
- Type and fixed-value choices expose listbox/option semantics.
- The picker has a localized dialog name, inputs have key-specific labels, and
  destructive clear/remove actions have explicit accessible names.
- Slash and shortcut matching stand down during IME composition.
- User property keys and values are never translated. Here `user.*` means a
  user-defined graph property, not private metadata owned by one account. All
  chrome comes from the typed English and Korean catalogs.
- Focus returns to the invoking row, textarea, or page subject after close.

## Dependency Direction

```text
outline slash state -------\
command bridge ------------+--> PropertyPicker --> GraphSession --> CorePort
page/block pointer routes -/          |                  |
                                       v                  v
                              entities/properties   refreshed snapshot
                                       |
                                       v
                                    UI / i18n
```

Feature code depends inward on `entities`, `core-port`, `i18n`, and `ui`. The
picker does not import Worker, Wasm, IndexedDB, Tauri, Loro, or query-index
implementations.

## Verification Boundary

- Component tests cover all five value types, custom keys, validation, direct
  row editing, slash-token removal, known enums, and tag separation.
- Outline tests continue to cover pending-row reconciliation, structure, undo,
  selection, and virtualization-sensitive focus behavior.
- Shortcut tests cover the new default, conflicts, formatting, and browser-key
  reservation rules.
- Browser tests cover property persistence, slash invocation, tag membership,
  query/task projections, accessibility, and reload.
- Native/Wasm contract suites cover property round-trip, persistence, rejection,
  and undo through the current CorePort corpus.
