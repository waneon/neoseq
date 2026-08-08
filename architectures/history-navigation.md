# Undo/Redo Navigation Architecture

## Purpose

Undo and redo can change an entity outside the visible page. The product makes
that result discoverable without coupling the Rust core to routes, viewport
state, or focus policy.

This architecture covers local undo/redo navigation only. Browser history,
remote-change attribution, and persisted history across graph reopen are outside
the current boundary.

## Contract

`CommandResult.history_effect` is present only for a changed undo or redo and
contains:

- `scope`: `entity`, `page`, or `graph`;
- `affected_pages`: the page IDs whose hydrated snapshots may be stale;
- `reveal`: at most one live page or block reference after the operation.

The effect describes semantic impact, not presentation instructions. It never
contains a URL, scroll offset, collapsed-state mutation, DOM identity, or focus
request. A missing reveal target means that reconciliation still occurs but the
client stays where it is.

## Core Ownership

`GraphCore` keeps one ephemeral `HistoryEntry` beside each local Loro undo item.
The undo and redo metadata stacks move in lockstep with Loro's stacks. A new
changed command clears redo metadata; a no-op creates neither a Loro item nor an
entry. A stack mismatch rejects the history command and rolls the Loro operation
back instead of publishing an uncorrelated effect.

Each entry records:

- semantic scope;
- affected pages;
- ordered target candidates for undo and redo.

Candidates are resolved only after Loro finishes the operation. The first live
candidate becomes `reveal`; invalid candidates fall through to a containing
block or page when available. Loro tree nodes may receive a new internal ID when
an insertion is redone or a deletion is undone, so those entries record a tree
position and resolve the resulting live block rather than returning a stale ID.

Graph-wide commands such as tag deletion report affected pages for cache
reconciliation but deliberately have no reveal target. The metadata is not CRDT
state, is not synced, and does not change the persisted graph schema.

## Session Ownership

`GraphSession` serializes the history command before any navigation. It uses
`affected_pages` to refresh only destination pages that are already hydrated.
The normal routed page loader hydrates a destination that was not previously in
memory. If an older adapter does not provide a history effect, the session falls
back to conservatively reconciling every hydrated page.

Navigation never begins before command execution and reconciliation succeed.
Failures leave the route unchanged and use the ordinary localized undo/redo
error surface.

## Client Coordination

`HistoryProvider` is mounted once per open graph and is the only UI entry point
for undo and redo. Global shortcuts, the command palette, overflow actions, and
the outline editor all call it with an invocation kind.

After a successful result it applies this policy:

1. Graph scope or no live target: keep the current route.
2. Page target: navigate only when another page is visible.
3. Block target on another page: retain a pending reveal and navigate to the
   page's canonical regular-page or journal route.
4. Block target on the mounted page: hand it directly to the registered
   outliner revealer.

The pending reveal survives the route transition. The destination outliner
registers again after page hydration, allowing the coordinator to retry a target
that was absent from the initial page summary.

## Outliner Reveal Policy

The outliner owns view mechanics because it owns collapsed state, editor focus,
and the virtualizer. For an accepted block request it:

1. verifies the block exists in the full authoritative page tree;
2. expands every collapsed ancestor;
3. waits until the block enters the visible flattened rows;
4. scrolls the virtualizer to its row;
5. applies the existing short reveal treatment;
6. focuses the editor only for history invoked inside the outline.

Global shortcuts, palette actions, and overflow actions reveal without stealing
focus. If the requested block is already the focused editor, the outliner keeps
its current caret rather than resetting it.

## Verification

Core tests cover cross-page effects, graph-scoped effects, deleted-block ID
resolution, and redo fallbacks. Component tests cover same-page ancestor
expansion, cross-page routing and reveal, focus preservation, and graph-wide
route stability. The fake CorePort mirrors the semantic metadata stacks so UI
tests exercise the same boundary as the Rust runtime.
