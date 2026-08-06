# Property Command Picker

Status: implementation-ready product specification
Scope: Web client first; the interaction contract also applies to later native clients

## Decision

Neoseq will add and change properties contextually, from the writing surface. The
current expanded property CRUD forms are replaced by two routes into one property
picker:

1. choose **Add property** from the block editor's `/` command menu; or
2. press `Mod+P` (`⌘P` on macOS, `Ctrl+P` elsewhere).

Both routes open the same picker for the same target and use the existing typed
property commands. A property already attached to the target can be changed or
cleared through the same flow.

This is based on direct use of Logseq's test application on 2026-08-06. The useful
parts of that interaction are the shared **Add or change property** picker, the
second value-selection step, contextual placement beside the block, and **Clear**
as part of the edit path. Neoseq keeps its own type system, validation, visual
tokens, command architecture, and accessibility contract rather than copying
Logseq's presentation literally.

## Goals

- Let a user attach a property without leaving the caret or opening an inspector.
- Make `/` and `Mod+P` converge after invocation.
- Make adding, changing, and removing a property one coherent flow.
- Preserve typed values, registry validation, repeated-property semantics,
  offline durability, undo/redo, and CorePort boundaries.
- Keep a complete pointer route for users who do not use keyboard commands.
- Restore the exact editing context after completing or dismissing the picker.

## Non-goals

- No change to the canonical `PropertyBag`, property encoding, registry fixture,
  or core commands.
- Tags remain first-class graph entities and are not turned into properties.
- System-owned keys remain page information and cannot be added from the picker.
- This work does not add schemas for user-defined repeated properties. An unknown
  key remains single-valued, as it is today.
- The `/` menu is not a general macro, plugin, or template system in this change.

## Target resolution

Property actions always resolve to one entity when invoked:

| Context | Target |
| --- | --- |
| Caret in a persisted block | That block |
| Caret in a pending block | Persist it, then target its real ID |
| One block selected and the outline owns focus | The selected block |
| More than one block selected | Disabled; asks the user to select one block |
| Page title or page property strip focused | Current page |
| No block or property surface focused | Current page |
| Read-only graph | Target resolves; mutations show the read-only reason |

The target is captured when the picker opens. A remote insert, virtualization, or
focus movement must not silently retarget an open picker.

## Entry routes

### `/` command

The slash menu belongs to a focused block textarea.

- Typing `/` at the start of a block or after whitespace opens the menu at the
  caret. A slash inside a word or URL remains ordinary text.
- Text between `/` and the caret is the command query. **Add property** matches
  `property`, `properties`, and `metadata` in every supported locale.
- The input remains the block textarea; the menu uses `aria-activedescendant` and
  does not move DOM focus away from the draft.
- `ArrowUp` and `ArrowDown` move the active result, `Enter` executes it, and
  `Escape` closes the menu.
- Dismissing the slash menu leaves the typed slash and query as ordinary text.
- Executing **Add property** removes only the slash trigger and its query from the
  draft, preserves text on both sides of it, then opens the property picker.
- IME composition never opens or executes the slash menu. Matching begins after
  `compositionend`.

The block's right-click menu also contains **Add or change property…**. This is
the pointer route for the slash command and opens the same picker directly.

### `Mod+P`

- The shipped Properties binding changes from `Mod+Shift+P` to `Mod+P`.
- On a graph route with a resolved target, the application calls
  `preventDefault()` and opens the picker. This intentionally takes precedence
  over the browser's Print command in that context.
- With no graph or no target, Neoseq does not consume the key; native browser
  printing remains available.
- The shortcut remains configurable in Settings. `Mod+P` is the one explicit
  exception to the current browser-reserved binding list because it is the
  product's requested default and is handled only when actionable.
- The page title context menu contains **Add or change property…** as the pointer
  route for page properties.
- Shortcut labels in the palette, menus, shortcut sheet, and settings all come
  from the resolved binding table and therefore change together.

## Picker flow

The flow has at most three stages. It is a popover on desktop and a bottom sheet
at or below the existing mobile breakpoint.

### 1. Choose a property

The header and accessible name are **Add or change property**. A combobox keeps
focus while a listbox shows candidates in this order:

1. properties already on the target, marked with their current value;
2. well-known registry properties not yet present;
3. **Create property “query”** when the query is a valid unknown key.

Matching is case-insensitive over the display key and localized feature aliases.
Canonical property keys remain the stored value and use the mono typography role.
System keys and structural reserved keys are never offered.

Choosing an existing single-valued property means “change this property,” not
“add a duplicate.” Choosing a repeated property opens the value stage with both
an **Add value** row and its existing members.

An unknown key goes to a type stage before its first value is entered. Its default
type is `string`; available types are `string`, `number`, `checkbox`, `date`, and
`page`. Choosing an unknown key always asks for its type; Neoseq does not infer
a type from unrelated entities or coerce their data.

### 2. Enter or choose a value

The value control comes from the property definition or chosen custom type:

| Type | Control | Commit |
| --- | --- | --- |
| Allowed strings | Searchable choice list | Select a row |
| Free string | Text input | `Enter` or explicit **Set** |
| Number | Numeric text input | Valid finite number + `Enter` or **Set** |
| Checkbox | **Checked** / **Unchecked** choices | Select a row |
| Date | Native date input plus **Today** | Choose a date |
| Page | Existing page autocomplete | Select a page |

When changing an attached property, this stage also contains **Clear property**.
For a repeated property, each current member has **Remove value** and the whole
key has **Clear property**.

The editor never commits a type's placeholder/default merely because the stage
opened. A value is written only after an explicit commit action.

### 3. Complete

On a successful command, the picker closes and returns focus to the captured
subject:

- a block restores `{blockId, selectionStart, selectionEnd}`;
- a page restores the title row or the property chip that invoked the flow; and
- an outline selection restores outline focus and the same selected block.

`Escape` from the value/type stage returns to the property list. `Escape` from
the property list closes the picker without mutation. Outside click has the same
effect as the final `Escape` and must not also append a block.

## Property presentation

The command picker replaces the current multi-control add forms; it does not hide
attached data.

### Blocks

- Non-system properties render as compact rows immediately below block Markdown
  and above child blocks, aligned to the block's text edge.
- A row shows `key` and formatted value. Well-known task/query projections may
  replace the generic value rendering, but the property remains reachable.
- Clicking a property row opens the value stage for that property.
- A block with no visible property renders no property chrome.
- The generic property section, empty hint, and permanent add row are removed from
  `BlockInspector`. Tag editing is extracted into a dedicated **Tags…** popover
  reached from the block context menu; existing tag chips and tag semantics do not
  change.

### Pages

- The collapsed `key: value` strip remains the at-rest summary.
- Clicking a chip opens that property's value stage directly.
- The expandable page CRUD panel and its add row are removed.
- An empty page bag renders nothing; page properties remain reachable through
  `Mod+P` and the title context menu.

### Read-only mode

Property rows and chips remain readable. Clicking one may show its complete value,
but edit, clear, and create actions are disabled with the shared read-only reason.

## Command and data semantics

The picker is presentation state. It dispatches the existing commands:

- `set_property`
- `remove_property`
- `add_repeated_property`
- `remove_repeated_property`

Known definitions continue to use the versioned core property registry. Client
validation runs before dispatch and the core remains authoritative. The existing
`query.source` behavior continues to materialize `query.language`. Each dispatched
core property command retains its current document-history behavior; this UI change
does not introduce a second undo model or change command grouping.

No property draft is written to the block's Markdown. The slash trigger is editor
syntax only and disappears when its command executes.

## State and failure behavior

The picker state is explicit:

```text
closed
  -> choose-property(target, return-focus)
  -> choose-type(target, key, return-focus)       # new unknown key only
  -> edit-value(target, definition, current-value, return-focus)
  -> committing(command)
  -> closed                                       # success
```

- Validation errors stay beside the active control with `role="alert"`.
- A rejected CorePort command keeps the picker and draft open and also uses the
  shared failure notification layer; it never creates a row that merely snaps
  back later.
- A duplicate repeated value is treated as unchanged and explained inline.
- While committing, only the commit action is disabled. Escape may close the
  surface, but completion still reports through normal session state.
- Offline operation is identical to other local commands and must not require a
  network request.
- The picker observes snapshot changes by entity ID. If the target is deleted
  remotely, it closes and reports that the target no longer exists.

## Visual and responsive contract

- Use the existing overlay, menu-item, input, typography, spacing, radius, and
  elevation tokens from `DESIGN.md`.
- Desktop width is `min(360px, available inline space)` and height is capped at
  320px before results scroll. It anchors to the caret when opened by `/`, to the
  subject row when opened by `Mod+P`, and to the pointer trigger otherwise.
- Mobile uses a bottom sheet with 32px minimum controls and safe-area padding.
- The overlay appears with opacity only; no transform animation is introduced.
- Long keys and values truncate visually but remain available in accessible text
  and in the value stage.
- Light and dark modes use the same semantic tokens; no property type introduces
  an additional structural color.

## Accessibility and keyboard contract

- The property field is a `combobox` with `aria-expanded`, `aria-controls`, and
  `aria-activedescendant`; candidates are non-focusable `option` elements.
- Result count and validation changes are announced politely.
- The current value, type, cardinality, and whether an action changes or clears
  data are available in accessible names, not color alone.
- `Tab` stays within the open picker or sheet. Closing always restores a visible
  caret/focus target.
- The first key handler guard remains IME composition, except that `Escape` may
  dismiss an already-open overlay according to the existing overlay contract.
- Slash query matching and custom property keys support Korean and other composed
  text without executing on intermediate composition events.

## Implementation boundaries

- `features/outline/` owns slash-trigger detection because it owns the block draft
  and caret.
- A reusable property picker under `features/properties/` owns target capture,
  property/type/value stages, validation presentation, and command dispatch.
- `features/commands/` continues to own the Properties binding and page/block
  target slots. The picker is not a second global keydown listener.
- Existing `ValueEditor`, property formatting, validation, and page autocomplete
  behavior should be extracted and reused rather than reimplemented.
- The slash command definition and global/pointer command definition share one
  action ID so labels, diagnostics, enabled state, and behavior cannot drift.
- No new frontend entity store or direct adapter call is permitted.

When implementation lands, `DESIGN.md` §§ Disclosure, Command Layer, Outline, and
Properties and `architectures/clients.md` § Command Layer must be updated in the
same change. Until then, those documents continue to describe the shipped UI and
this file describes the approved replacement.

## Acceptance criteria

### Invocation

- [ ] `/pro` can choose **Add property**, removes only `/pro`, and opens the picker
      for the block containing the caret.
- [ ] A slash in `https://`, `a/b`, or during IME composition does not open the
      menu.
- [ ] Dismissing the slash menu preserves the literal slash/query.
- [ ] `Mod+P` opens the same picker for a focused persisted or pending block.
- [ ] `Mod+P` targets the page when no block is active and does not consume the
      key when no graph target exists.
- [ ] Block and page context menus provide equivalent pointer routes.

### Property operations

- [ ] Known single and repeated properties can be added, changed, and cleared.
- [ ] Unknown string, number, checkbox, date, and page properties round-trip after
      reload without coercion.
- [ ] Allowed-string properties are limited to their registry choices.
- [ ] Reserved/system keys are absent and a manually entered reserved key produces
      a visible validation error.
- [ ] Page reference autocomplete preserves tombstones and does not create a page
      merely by displaying a missing reference.
- [ ] A core rejection leaves the draft editable and reports exactly once.
- [ ] Every successful action survives an offline reload and participates in undo/redo.

### Interaction quality

- [ ] Pointer, keyboard-only, and screen-reader routes reach the same actions.
- [ ] `Escape`, outside click, successful commit, virtualization, and remote updates
      restore focus or close with the behavior specified above.
- [ ] Opening or dismissing a picker never appends an empty block.
- [ ] Read-only mode exposes values and clear reasons without dispatching commands.
- [ ] Korean IME tests cover `/` invocation, picker search, value entry, and Escape.
- [ ] Desktop/mobile and light/dark visual tests cover empty, populated, error,
      long-value, and read-only states.

## Removal and migration

Implementation removes the existing `AddPropertyRow`-driven workflow, block
inspector's generic property section, expanded page property form, their obsolete
messages/styles, and tests that exist only to drive those forms. The tag editor
is extracted before the rest of the inspector is removed. Core commands, persisted
data, property registry fixtures, tags, task/query projections, and
unknown-property round-trip tests remain. Existing graph data requires no migration.
