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

## Verification

Behavior contracts run against outline and query hosts for shared input
semantics. Separate tests assert each surface's structural policy, contextual
target precedence, canonical persistence, view-switch draft retention, and
failed-write recovery.
