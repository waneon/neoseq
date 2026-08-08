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

export const TASK_KEYS = [
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

/** Done and cancelled are settled: their text reads as struck through. */
export function isSettledStatus(status: string): boolean {
  return status === "done" || status === "cancelled";
}

/** 1–3 for the registry's suggested priorities, 0 for anything else. */
export function priorityLevel(priority: string): number {
  return TASK_PRIORITIES.indexOf(priority) + 1;
}
