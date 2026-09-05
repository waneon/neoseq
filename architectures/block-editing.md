# Block Editing Architecture

## Boundary

A block has one editing language regardless of where it is projected. Outline
rows and editable query results share the native text-input boundary, completion
grammar, semantic commands, and canonical write path. They do not share tree
navigation or structural ownership.

`features/blocks/editor` is the shared, surface-neutral layer:

- `BlockTextArea` owns native `beforeinput`, auto-pairing, generated-closer
  provenance, and IME-safe input repair;
- native editor sizing observes both text and available width; CSS owns each
  surface's line-height and height constraints;
- `activation` turns an explicit pointer, keyboard, programmatic, or contextual
  entrance into modal intent before a host opens its draft;
- `surface-policy` names the few deliberate behavioral differences between
  outline, query list, and query table hosts;
- block completion modules own `/`, `#`, and `[[` token detection, ranking, token
  removal, and menu presentation; and
- graph-scoped content sessions own semantic edits and their canonical settlement.

One content session addresses an outline owner and block ID, independently of
the surface displaying it. Its buffer is an immutable semantic source plus
pieces that retain source ranges or insert authored atoms. A Unicode scalar and
a page reference are each one atom. Markdown and reference offsets are derived
from those pieces and the current page directory; renaming a page does not
rewrite a draft. A native edit through a reference demotes only that reference
to readable source. Completion inserts a page atom; hosts never manipulate Loro
marks.

The session consumes each canonical publication synchronously. It maps retained
source ranges and native selection through the actual ordered edits supplied by
the core, including remote edits and history. Equal final text does not imply
equal edit history. Local deletions remove observed source atoms and preserve
concurrent insertions. Native composition keeps its original input projection;
canonical mappings accumulate until composition ends. A missing mapping across
a changed dirty source, or deletion of its target, retains the draft and refuses
to submit stale positions. Clean sources can be replaced directly.

Submission lowers the current pieces inside the graph command queue, after
preceding canonical publications. Separate text edits remain separate ordered
splices in one atomic command and history unit. Settlement advances the source
while preserving subsequent input. A rejected command restores its edits and retains its semantic actions in the
target, so another surface can retry the same intent and identity; an
applied command whose local save failed remains applied. Idle clean buffers are
released, while lightweight target identities live with the graph so native
observers survive effect reattachment.

Completion menus follow their focused editor through list, caret, and document
scrolling. Reconciliation may replace the textarea, but the completion remains
attached to the focused canonical editor until selection, outside press, or
Escape closes it. Outline and query-result hosts share this interaction through
the completion presentation. An outline completion addresses its surface and
block identity; the panel resolves its current native anchor when measuring or
checking detachment, including during pending-to-canonical adoption.
The shared anchored panel alone owns outside press
and overlay dismissal; host-level window listeners must not compete with it.

A surface owns focus, composition boundaries, completion state, flush scheduling,
failure presentation, and the meaning of structural keys. Its content comes from
the shared target. Structural hosts edit, splice, adopt, or reset individual
targets; they never replace the graph's buffer collection or discard drafts by
comparing display strings. Rows subscribe to their own target, while ordinary
props describe focus and selection and an action reference supplies current
event handlers. Immutable tree and page-directory indexes are shared by outline
and query projections. All writes use ordinary `GraphSession` commands; a query
result never writes through the derived index. Both coordinators flush final
debounced input when their route unmounts. Both hosts wait for a successful
content submission before document history; rejection retains the draft and
stops the history request. Query commits wait for an in-flight write before draining newer input or running
document history; a failed write ends that drain and remains an explicit failure.
Result switching and contextual pickers wait for the current draft to settle.
Semantic completion choices remain visibly unavailable while a prior write is
pending or rejected; refusing them preserves the token and completion menu.
Background drains pause at an open completion, while explicit blur, navigation,
and history requests still flush the draft.
Page completion prepares its semantic buffer and entity commands in the shared
editor layer and uses the same save lifecycle as ordinary text; retries lower
the retained semantic pieces and preserve newer local input.
Only editor activation assigns focus, so save notifications cannot reclaim focus
from a subsequently requested control.

The outline keeps persistence drafts distinct from pending structural projections.
In particular, splitting a dirty block retains the complete draft long enough to
serialize the canonical write, while one pending operation projects its source and
created halves together. Acknowledgement replaces only the temporary identity; it
does not introduce a second content transition. Semantic reference spans split and
rebase with their half of the projection.

Deleting a block boundary uses the same separation. The pending merge projects one
combined target and removes the source while the complete canonical merge is in
flight. Dirty endpoints settle before this projection replaces their sources.
Its join caret is stable, and edits arriving there use the merged content
as their source. The content session explicitly acknowledges this predicted
structural source so the merge's mapping is not applied a second time. A rejected
command removes the whole projection and restores the source caret.
An authoritative read failure after application retains the known result and
pending projection. Dependent placements wait for a successful reread; repeated
read failures keep queued input visible. The structural command is never
replayed to recover its presentation.

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

| Behavior                          | Outline              | Query list               | Query table              |
| --------------------------------- | -------------------- | ------------------------ | ------------------------ |
| Markdown and entity commands      | shared               | shared                   | shared                   |
| Reading projection                | full block           | full block               | compact phrasing         |
| `Enter`                           | split canonical tree | commit edit              | commit edit              |
| Structural mutation and selection | owned                | unavailable              | unavailable              |
| Cross-block Vim motion            | owned                | unavailable              | unavailable              |
| Content target                    | graph-scoped         | same graph-scoped target | same graph-scoped target |
| Result invalidation               | not applicable       | active stale row pinned  | active stale row pinned  |

The policy matrix is executable configuration rather than scattered conditionals.
Hosts consume it, but domain and interaction primitives never inspect the current
surface. Adding a projection therefore requires one explicit policy entry and a
host adapter, not a fork of the block editor.

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
carries its input method explicitly. A shared entrance records a press before
the browser delivers its focus, so modal transition and draft activation occur
in that focus event's single commit rather than in separate focus and click
frames.

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
semantics. A matrix test freezes each surface policy; host tests assert the same
activation transition, contextual target precedence, canonical persistence,
view-switch draft retention, and failed-write recovery.
