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
not editable generic fields. Query creation is also available here; it opens the
same complete query as the slash command, then hands editing to the builder.

The property selector is a compact, searchable inventory. Existing properties
appear together under the current block, page, or tag, with their values aligned
for scanning. Available properties form a separate group with short descriptions
that explain their purpose. The entire matching collection remains reachable by
scrolling and keyboard navigation; the footer makes the keyboard controls visible.
A persistent New property action opens an editable name and explicit type choice.
Type descriptions explain the data each choice holds. Creation remains one local
draft through value editing, and going back allows the name and type to change
without losing the draft or writing a partial property.

Reference pickers keep keyboard focus in the search field and select only from
an open list. A pending choice runs once; rejection preserves its label for
retry. A property editor keeps ownership of a submitted change until it settles,
including any text edit bundled with it, so dismissal cannot repeat part of an
intent. The shared overlay restores focus to the invoking control or the page's
persistent title/action control.

## Tag References and Identity

A tag beneath a block is a reference. Its name navigates to the tag; an adjacent,
independently named remove control detaches membership. Read-only surfaces retain
navigation. A missing tag becomes a tombstone rather than promising navigation.
The membership picker shows applied tags and a searchable list of available tags
with their marks and groups. Adding a tag leaves the picker ready for another;
creating a tag and applying it is one command intent.

Every live tag has a mark, safe hue, optional group, and position. The mark is the
familiar tag sign or one user-selected glyph. It stays glyph-like across the rail,
directory, references, and tag header. Color uses the bounded hue family from the
[visual foundation](foundations.md).

The mark and a labeled Customize action open the same identity editor. A preview
shows the draft beside the tag name. Mark, color, and group form one draft: Done
applies them as one undoable change, while dismissal discards them. Group entry
supports existing choices and a new name in an anchored suggestion list that never
shifts the surrounding editor. Creating a
tag uses the same group field and an explicit, validated submission.

## Groups and Ordering

A group is a name carried by tags, not an independent entity. It exists while at
least one tag belongs to it and is renamed by updating its members. Ungrouped
tags collect at the end, with a heading only when named groups make it useful.

Tag and group positions retain one shared placement model. Dragging previews an
insertion seam without reflow; menu movement supplies keyboard and touch routes.
Search or a group filter disables reordering so a partial view cannot imply the
order of hidden items. Group actions always address the full membership of the
group, including tags outside the current search.

## Tag Directory and Tag Page

The directory is a searchable library. A stable header holds creation, the title,
and a total. Search and group filters narrow the list together. Rows give the tag
name the primary reading edge, place default-property context beneath it, and
align usage counts under a named column. Menus remain visible. Identity, navigation,
and actions are sibling controls, never nested interactive targets.

Empty and unmatched lists have distinct next actions. Creating a tag uses a focused
dialog with a name, optional group, explicit submit and cancel, and inline duplicate
or failure feedback. Successful creation returns to the complete directory; failed
submission preserves the draft.

A tag page shares the document header language: a route back to Tags, visible
customization and menu actions, then the full-width title and group. Connected
content is the primary collection. Default properties occupy a compact disclosure
with a count and a persistent Add action. Expanded defaults use key/value rows and
explain that applying a tag copies missing values rather than maintaining a live
inheritance relationship. Notes have their own named outline section, followed by
references. Disclosure is session state and never changes the graph.

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
`Mod+Enter` while writing cycles `todo` → `doing` → `done` → no status. It retains
other task facts and does not split the block or finish editing the result.

## Moments

A task moment is one object composed of a day and optional time. It keeps the
same written and tonal identity across outline chips and query cells, while its
outer affordance follows the surface: the chip edits directly, whereas an
interactive result cell owns the edit action.
One presentation model resolves the localized label, formatted day and time,
relative distance, recurrence mark, urgency step, and reader-owned tone. Chip and cell appearances
project that model; they do not recalculate its meaning. A new surface may choose
another affordance, but it must consume the same model.
Its editor treats date, time, and task-level recurrence as one intent. Natural
input exposes its full interpretation as a proposal; Enter applies that proposal
and dismisses after a successful save, while choosing the proposal moves it into
the local draft for further adjustment. The calendar, clock, and cadence controls
shape that draft without persisting partial state; Done applies it as one undoable
change and cancellation applies none of it. The calendar follows every chosen
date and treats the adjacent dates it shows as real choices. On a wide surface a
compact date column sits beside fixed time and recurrence slots; disabled slots
remain visible and quiet so toggles do not move the editor. A compact surface
preserves the two work areas as tabs instead of stacking them into a long sheet.

Urgency is expressed by both language and a bounded semantic tone. A time of day
is never presented as an independent query column because it has no meaning
without its day; the moment column carries both and computes urgency from both.
Every task time is written as `HH:MM` on a 24-hour clock, independent of the
interface language.
Active moments keep the exact date and optional time alongside a short relative
label. Scheduled dates describe distance ("in 6 days", "2 days ago"); deadlines
describe time remaining or elapsed ("6 days left", "2 days overdue"). Calendar
days determine the distance, with explicit today and tomorrow labels. A time on
the current day refines the distance to hours and minutes, with "now" at the
current minute. Settled tasks retain only the absolute date and time. Every
surface follows the configured timezone and a shared minute clock, refreshing
on resume and at day boundaries without graph changes. Compact values prioritize the relative text when space is limited; the full value stays available to accessible names
and hover text when the date is shortened.

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
