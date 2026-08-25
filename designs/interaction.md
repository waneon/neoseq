# Interaction Design Architecture

## Boundary

The interaction language defines how controls communicate state, how choices and
overlays behave, how objects move, and how the system reports work and failure.
Feature documents decide which actions exist; this document makes equivalent
actions behave equivalently across surfaces.

## Control States

Every control defines rest, hover, focus, pressed, disabled, and—where
applicable—open or selected state. Those states use the shared foundation roles:

- hover changes the surface or raises an already raised control;
- focus adds a halo outside the resting edge without changing geometry;
- press deepens an inset control or removes a raised control's cast;
- disabled controls remain visible, semantic, and accompanied by a reason when
  shown in the command layer; and
- borderless typing surfaces use the caret as their focus appearance.

Transforms do not simulate a press. A control does not move away from the pointer
that is activating it.

## Selection and Indicators

A closed set of peer states uses a segmented control: one recessed track and one
raised current key. The raise is the complete visible selection signal; accent,
extra weight, or a rule is not layered on top.

Keyboard roving and persistent location are different:

- A roving highlight is a neutral row wash in menus, lists, and the command
  palette. It predicts where the next key action will land.
- A chosen value uses a check or equivalent semantic mark, not a second wash.
- A persistent location indicator identifies the pane currently on screen and
  remains while focus moves elsewhere.

Focus never impersonates current location, and structural block selection never
impersonates the typing caret.

## Choice

Lists of product choices use one accessible menu/listbox language with the same
roving, selection, dismissal, and keyboard behavior. A trigger retains field
shape and states its open relationship to the popup.

A closed, non-filterable set is a select. A filterable set is a combobox backed
by a listbox. Features own the domain values and labels, while the combobox owns
active-option focus, filtering, and selection semantics.

Native controls remain where the platform provides the better precision or
semantics, including checkboxes and date/time pickers. Color is selected by
pressing a visible, bounded swatch rather than by opening a generic text list or
free-form picker.

The same domain value opens the same choice model on every surface. A value does
not gain a different popup merely because it is projected in a table or has not
yet been loaded into the current outline.

## Direct Manipulation

A drag communicates the destination, not merely that dragging is happening. An
insertion seam occupies the gap or boundary where the object will land; a region
wash is reserved for cases where the region itself is the destination.

The carried object may fade, but siblings do not reflow before commit. Pointer,
keyboard, menu, and touch routes resolve to the same placement semantics. A
drag-only ordering capability is incomplete.

Objects retain their primary cursor and meaning at rest. A navigable row does not
look permanently draggable, and interactive siblings are never nested inside a
larger interactive element.

## Overlay Model

Dialogs, menus, popovers, palettes, and toasts share one layer order. An overlay
is portaled into the modal context that summoned it, or into the application
layer when no modal is active. Outside press, selection, and Escape dismiss the
appropriate layer; Escape always belongs to the topmost open surface.

Anchored surfaces prefer the available vertical side and constrain themselves to
the room there. Point-like anchors open toward the viewport center; field-like
anchors preserve the field edge because the popup stands in for that field.

An anchor is either a measurable live element or a captured box. Zero-area
geometry is absence, not the viewport origin. If a live anchor disappears, the
overlay keeps its last valid position; callers that know their element will be
replaced provide a captured box.

Opening and closing restore focus to the invoking control or caret unless the
chosen action explicitly transfers focus elsewhere.

A destructive confirmation is an alert dialog. It names the irreversible
effect, places initial focus on the safe action, and stays open while completion
is unresolved or has failed.

## Stable Geometry

Controls, dialogs, palettes, and result strips do not resize while a pointer is
travelling toward an existing target. Content may scroll within a stable frame.
Async results reserve structural slots when their arrival would otherwise shift
nearby labels or controls.

Size changes that reveal content may animate the container, but content already
on screen does not translate relative to that container. This rule governs
settings panes, command results, query headers, table resizing, and disclosure.

## Feedback and System State

Healthy steady state is silent. Save, sync, and live status appear only while
work persists beyond a short flash threshold or when the state deviates from
healthy. Failures use plain language, name the failed action, and are owned by
one surface.

Inline state has priority when the failure has a natural home. Toasts are for
failures or results with no visible owner. A toast pairs tone with a glyph or
text, announces at the appropriate urgency, collapses repeats, pauses an honest
countdown during interaction, and offers actions only as secondary routes.

Loading below the flash threshold shows nothing. Empty state is the next useful
action, not decoration. Failure preserves the surrounding shell; read-only state
explains unavailable actions; rejected commands are never silent and never
reported twice.

Focus, keyboard, touch, announcement, and dismissal requirements follow
[Accessibility](accessibility.md).
