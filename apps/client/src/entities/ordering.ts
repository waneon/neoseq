// One number per item, and the arithmetic that keeps it that way.
//
// A reader's own order — tags inside a group, favourites in the rail — is stored
// as a position on each item rather than as a list somewhere else, because a list
// is a second place a name can go stale and a second thing to reconcile when two
// replicas both reorder. Positions are spaced a thousand apart, so an ordinary
// move lands on the midpoint between its new neighbours and writes only the item
// that moved.
//
// Two things follow from that, and they are the whole model:
//
//   - **Unplaced sorts last.** An item that has never been arranged has no
//     position, so it follows everything that has, where the caller's own
//     fallback — a name, usually — decides. Creating or starring something
//     therefore never reshuffles what is already arranged.
//   - **An exhausted gap respaces.** Halving a gap forever is not something a
//     double can do, and a run whose members carry no position has no midpoint
//     to take. Both cases give every item in the run a fresh, evenly spaced
//     position: the one case where a move writes more than what moved.

/** How far apart fresh positions are placed, leaving room to land between them. */
export const ORDER_STEP = 1024;

/**
 * The narrowest gap a midpoint may be taken from. Below it the halves stop being
 * distinguishable at the precision a double carries.
 */
const MIN_GAP = 1 / 1024;

/** An item as an ordering sees it: an identity, and the place it holds. */
export interface Placed {
  id: string;
  /** `null` when it has never been arranged. */
  order: number | null;
}

/** One item's new place. */
export interface Placement {
  id: string;
  order: number;
}

/**
 * Placed before unplaced, and placed in their order. `0` means the two are
 * indistinguishable here, which is the caller's cue to fall back to a name:
 * `place(a, b) || compare(nameA, nameB)`.
 */
export function place(left: number | null, right: number | null): number {
  if (left !== null && right !== null) return left - right;
  if (left !== null) return -1;
  if (right !== null) return 1;
  return 0;
}

/**
 * Where a brand-new item goes: after everything, so making one never moves what
 * is already arranged.
 */
export function nextOrder(items: readonly Placed[]): number {
  return items.reduce((top, item) => Math.max(top, item.order ?? 0), 0) + ORDER_STEP;
}

/**
 * The writes that put `ordered` in that order, given that only `movedId` changed
 * place. Its new neighbours decide: a midpoint between them where both are known
 * and the gap can still be halved, and otherwise the whole run respaced.
 */
export function moveWrites(ordered: readonly Placed[], movedId: string): Placement[] {
  const index = ordered.findIndex((item) => item.id === movedId);
  if (index < 0) return [];
  const previous = index > 0 ? ordered[index - 1].order : null;
  const next = index < ordered.length - 1 ? ordered[index + 1].order : null;
  const known =
    (index === 0 || previous !== null) && (index === ordered.length - 1 || next !== null);
  if (known) {
    const low = previous ?? (next ?? ORDER_STEP) - 2 * ORDER_STEP;
    const high = next ?? (previous ?? 0) + 2 * ORDER_STEP;
    if (high - low > MIN_GAP) return [{ id: movedId, order: (low + high) / 2 }];
  }
  return respace(ordered);
}

/**
 * The writes that move one whole run of items between its neighbouring runs. A
 * group has no record of its own — its place *is* its members' places — so
 * moving one is moving them, bounded by the run's size.
 */
export function runWrites(runs: readonly (readonly Placed[])[], movedIndex: number): Placement[] {
  const moved = runs[movedIndex] ?? [];
  if (moved.length === 0) return [];
  const bound = (run: readonly Placed[] | undefined, pick: (values: number[]) => number) => {
    if (!run) return null;
    const values = run.map((item) => item.order);
    return values.every((value) => value !== null) ? pick(values as number[]) : null;
  };
  const previous = bound(runs[movedIndex - 1], (values) => Math.max(...values));
  const next = bound(runs[movedIndex + 1], (values) => Math.min(...values));
  const known =
    (movedIndex === 0 || previous !== null) && (movedIndex === runs.length - 1 || next !== null);
  if (known) {
    const low = previous ?? (next ?? ORDER_STEP) - (moved.length + 1) * ORDER_STEP;
    const high = next ?? (previous ?? 0) + (moved.length + 1) * ORDER_STEP;
    const stride = (high - low) / (moved.length + 1);
    if (stride > MIN_GAP) {
      return moved.map((item, offset) => ({ id: item.id, order: low + stride * (offset + 1) }));
    }
  }
  return respace(runs.flat());
}

/** Every item in the run gets a fresh, evenly spaced position. */
export function respace(items: readonly Placed[]): Placement[] {
  return items.map((item, index) => ({ id: item.id, order: index * ORDER_STEP }));
}
