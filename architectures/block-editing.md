# Block Editing Architecture

## Boundary

A block has one editing language regardless of where it is projected. Outline
rows and editable query results share the native text-input boundary, completion
grammar, semantic commands, and canonical write path. They do not share tree
navigation or structural ownership.

`features/blocks/editor` is the shared, surface-neutral layer:

- `BlockTextArea` owns native `beforeinput`, auto-pairing, generated-closer
  provenance, and IME-safe input repair;
- block completion modules own `/` and `#` token detection, ranking, token
  removal, and menu presentation; and
- text diffs translate drafts to `splice_markdown` command payloads.

An external document scroll dismisses a completion menu without changing its
token or caret. Scrolling the completion list itself keeps it open. Outline and
query-result hosts share this interaction through the completion presentation.

An editor surface owns the draft session around that input. It reconciles a
canonical `BlockSnapshot`, schedules or flushes writes, reports failure, and
chooses the meaning of structural keys. All writes still use ordinary
`GraphSession` commands; a query result never writes through the derived index.

Editable plain text keeps one textarea DOM boundary at rest and while focused.
Focus starts the surface's draft session, so the browser retains the pointer's
native caret instead of spending the first click replacing a display trigger.
Rendered Markdown follows the outline's existing preview-to-source hand-off.
An unhydrated cross-owner result remains temporarily read-only until its
canonical block is available, without replacing the input element.

## Surface Adapters

Text-local and entity-local behavior is invariant: pairing, IME handling,
Markdown completions, properties, tags, task commands, and document history use
the shared paths. Surface-local behavior is explicit:

| Behavior | Outline | Query result |
| --- | --- | --- |
| Markdown and entity commands | shared | shared |
| `Enter` | split canonical tree | commit reference edit |
| `Tab`, empty backspace, drag | mutate tree | unavailable |
| Multi-block selection and presence | owned | unavailable |
| Draft lifetime | focused outline row | query coordinator, retained across Table/List |
| Result invalidation | not applicable | active stale row remains pinned |

The visual `BlockPresentation` primitives remain presentation-only. A universal
row component with structural mode flags would mix query navigation with tree
ownership and is not part of this architecture.

## Contextual Commands

Focused block targets register with the command bridge in focus order. The most
recent live target wins; removing a nested query target restores its containing
outline target. The mounted page or tag is only the fallback when no block target is
active. A request captures the stable outline owner and block ID before opening a picker, so
later focus changes cannot retarget the mutation.

## Editor Keymaps

The browser-local editor keymap is either `standard` or `vim`; it is presentation
state and never graph data. The Vim keymap retains the native textarea and the
canonical draft/write path. A surface-level Vim session owns only modal grammar
state (mode, count, pending operator and text-object qualifier, and desired
vertical column); text and caret positions remain in the controlled value and
DOM selection.

Key arbitration is fixed: IME composition, an open completion menu, the active
editor keymap, the surface's structural policy, then global modifier shortcuts.
Normal mode rejects native text insertion at the shared input boundary without
marking the canonical field read-only. Insert mode therefore keeps the same
composition, auto-pair, and completion behavior as the standard keymap.
Pointer activation enters Insert mode at the chosen caret; keyboard motion
between blocks retains the current modal state. Editor activation therefore
carries its input method explicitly: focus, selection release, and the modal
transition are one host-owned state change, never separate focus and click
heuristics. A press records itself before the browser delivers the focus it
caused, so the entrance that reaches a settled line is the press's own and not
the `click` that follows it a frame later.

The active mode is named where the surface has room to name it: above the
outline's first row, and in a query cell by the caret alone, since a cell has no
structural unit to open and no line of its own to spend.

Visual Line is the Vim entry point to the outline's existing structural block
selection, not a DOM text range. The interpreter emits linewise intents while
the outline owns stable anchor/head block IDs, derives their visible range, and
hands focus to the tree. Motions advance between visually distinct selections,
so descendants already covered by an ancestor do not become hidden motion
steps. Leaving the mode restores a native caret at the active
end. Query projections advertise no linewise-selection capability and remain in
Normal mode when `V` is pressed.

Text motions and motion-based delete/change operators are shared. Structural
intents are adapted by the host: the outline treats visible block Markdown as a
word-motion stream whose separators retain the block tree, so `w`/`b`/`e` and
their operators may cross blocks without joining or deleting them. Multi-block
text edits are one atomic CorePort command and one history step. Word text
objects (`iw` and `aw`) are local to the active block and compose with delete and
change operators. The outline also provides cross-block `j`/`k`, `o`/`O`, `dd`,
and `>>`/`<<`; query result editors accept only text-local effects and document
history.

## Verification

Behavior contracts run against outline and query hosts for shared input
semantics. Separate tests assert each surface's structural policy, contextual
target precedence, canonical persistence, view-switch draft retention, and
failed-write recovery.
