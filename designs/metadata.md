# Metadata Design Architecture

## Boundary

Metadata makes authored blocks and page roots behave as records without turning
the outliner into a form builder. This boundary owns the presentation of
properties, tags, task state, moments, tag organization, and consistent controls
for those values across outlines and query results.

The domain architecture owns property meaning and mutation. This document owns
how those meanings remain recognizable and editable wherever they are projected.

## Property Presentation

Properties are quiet metadata attached to writing. Empty metadata does not leave
an empty form behind; existing values appear as compact rows, marks, or chips
whose shape communicates whether they navigate, choose, or edit.
An inline metadata strip stays visually attached to the writing it describes
and leaves only the ordinary list rhythm before the next block; one property
does not turn a block boundary into a paragraph break.

One contextual property picker is the authoring surface reached from writing,
commands, and context menus. The route may differ, but the value semantics and
control do not. Dates accept language-oriented input while retaining the
platform picker as a precision route. System-owned keys appear as information,
not editable generic fields.

## Tag References and Identity

A tag beneath a block is a reference. It uses the quiet accent and link behavior,
and pressing it navigates to the tag. Removing a tag is a separate editing action
inside the property surface or contextual menu; the most link-like object on a
row is never destructive.

A deleted tag becomes a tombstone: it gives up link styling, states its missing
condition, and no longer promises navigation.

Every live tag has a mark, color, optional group, and position. The mark is either
the familiar tag sign or one user-selected glyph, and it is also the disclosure
for editing tag identity. Color comes from the bounded hue family defined by the
[visual foundation](foundations.md), so a tag cannot choose an illegible state.
The mark remains glyph-like; it does not gain a decorative tile that would turn
every tag row into a field of colored boxes.

## Groups and Ordering

A group is a name carried by tags, not an independent entity. It exists while at
least one tag belongs to it, is renamed by updating its members, and has no
separate lifecycle to synchronize. Ungrouped tags collect at the end under a
heading only when that heading distinguishes them from named groups.

Tag order and group order are expressed through member positions. Dragging and
keyboard/menu movement share one placement model and preview the destination
with the common insertion seam. The list does not reflow until the move commits.

## Tag Directory and Tag Page

The tags surface is a directory rather than a card grid. Group headings organize
rows; each row combines a navigable name, its identity mark, contextual actions,
and a derived usage count. Sibling controls form one row without nesting one
interactive element inside another.

A tag's page presents its name, group, defaults, query, and outline as aspects of
one place. Default properties are key/value rows with shared columns, not chips.
The tag mark and property marks share one column so the text the tag says begins
on one edge. Empty guidance explains what defaults mean and disappears once the
rows explain themselves.

## Tasks

A task is any block carrying task properties; it is not a separate visual object
or storage shape. Status and priority are shape-first marks before the text. They
may use semantic tones, but color never replaces their distinct shapes. Settled
states alter the line itself and no longer display urgency.

The same value opens the same controlled menu in an outline, list result, or
table cell. If a result names a block that is not resident, the client resolves
the block before opening the control; available memory must never determine
which editor a value receives.

Choice menus preserve stored values outside the current suggested set and make
removal explicit; merely opening an editor never rewrites data. Completing one
occurrence of a recurring task advances its moments by the stored cadence and
keeps the task active rather than presenting the whole task as finished.

## Moments

A task moment is one object composed of a day and optional time. It keeps the
same written and tonal identity across outline chips and query cells, while its
outer affordance follows the surface: the chip edits directly, whereas an
interactive result cell owns the edit action.
Its editor holds date, time, and the task-level recurrence as one draft. Search,
quick choices, the calendar, the clock, and the cadence never persist partial
state; explicit confirmation applies the whole intent as one undoable change,
while cancellation applies none of it. On a wide surface the date and calendar
occupy the primary column while time and recurrence share a quieter secondary
column. A compact surface preserves those two work areas as tabs instead of
stacking them into a long sheet.

Urgency is expressed by both language and a bounded semantic tone. A time of day
is never presented as an independent query column because it has no meaning
without its day; the moment column carries both and computes urgency from both.
Every task time is written as `HH:MM` on a 24-hour clock, independent of the
interface language.
Today is its own fixed urgency step: it does not disappear into a configurable
future range, while a time already passed today remains overdue.
The default tonal progression is danger, attention, caution, information, then
neutral; success green never stands in for temporal urgency.
Each step has one compact color well. Its popover previews the resulting chip in
both light and dark mode, offers safe named presets, and lets the reader choose a
continuous hue and bounded chroma. The reader owns those two coordinates;
mode-specific lightness remains a system invariant so a custom choice cannot
make the other mode illegible.

Shared choice and overlay behavior follows [Interaction](interaction.md).
