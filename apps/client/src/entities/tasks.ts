// The task lens over well-known properties.
//
// A task is not a storage shape: it is any block or page whose bag carries one
// of the four `builtin.task-*` keys. The value lists here are derived from the
// property registry, so the UI can never offer a status the domain does not
// suggest — and an arbitrary stored string remains valid and stays listed,
// because `suggested` values are hints, not restrictions.

import { stringChoicesOf } from "./properties";

export const TASK_STATUS_KEY = "builtin.task-status";
export const TASK_SCHEDULED_KEY = "builtin.task-scheduled";
export const TASK_DEADLINE_KEY = "builtin.task-deadline";
export const TASK_PRIORITY_KEY = "builtin.task-priority";

const TASK_KEYS = [
  TASK_STATUS_KEY,
  TASK_SCHEDULED_KEY,
  TASK_DEADLINE_KEY,
  TASK_PRIORITY_KEY,
] as const;

export const TASK_STATUSES: readonly string[] = stringChoicesOf(TASK_STATUS_KEY);
export const TASK_PRIORITIES: readonly string[] = stringChoicesOf(TASK_PRIORITY_KEY);

export function isTaskKey(key: string): boolean {
  return (TASK_KEYS as readonly string[]).includes(key);
}

/** Strongest first, because raising something is why a priority list is opened. */
const PRIORITY_OFFER_ORDER: readonly string[] = ["high", "medium", "low"];

/**
 * The order a choice list offers a property's suggested values in.
 *
 * The registry states its values in the domain's own ascending order, which is
 * the right order to *store* and the wrong order to *read*: `low` arrived at the
 * top of the priority list, one row further from the pointer than the answer
 * almost every reader is reaching for. Status keeps the registry's progression
 * (todo → doing → done → cancelled) because that is the order the work moves in.
 * A stored value outside the suggested set keeps its place at the end.
 */
export function offeredChoices(key: string, choices: readonly string[]): string[] {
  if (key !== TASK_PRIORITY_KEY) return [...choices];
  const rank = (value: string) => {
    const index = PRIORITY_OFFER_ORDER.indexOf(value);
    return index < 0 ? PRIORITY_OFFER_ORDER.length : index;
  };
  return [...choices].sort((left, right) => rank(left) - rank(right));
}

/** Done and cancelled are settled: their text reads as struck through. */
export function isSettledStatus(status: string): boolean {
  return status === "done" || status === "cancelled";
}
