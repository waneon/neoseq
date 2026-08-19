// Localized names for the registry's suggested task values. A stored value
// outside the suggested set is shown verbatim — it is the user's own word.

import type { RepeatInterval } from "../../entities/tasks";
import { TASK_PRIORITIES, TASK_STATUSES } from "../../entities/tasks";
import type { MessageFunction } from "../../i18n";

export function statusLabel(status: string, message: MessageFunction): string {
  if (!TASK_STATUSES.includes(status)) return status;
  return message(`task.status.${status}` as
    | "task.status.todo"
    | "task.status.doing"
    | "task.status.done"
    | "task.status.cancelled");
}

export function priorityLabel(priority: string, message: MessageFunction): string {
  if (!TASK_PRIORITIES.includes(priority)) return priority;
  return message(`task.priority.${priority}` as
    | "task.priority.low"
    | "task.priority.medium"
    | "task.priority.high");
}

/**
 * An interval in words. The count drives plural selection in the catalog, so
 * "every day" and "every 2 days" are one message per unit rather than a stitched
 * number and noun — which is the only way this reads correctly in Korean too.
 */
export function repeatLabel(interval: RepeatInterval, message: MessageFunction): string {
  const key = ({
    d: "task.repeatEvery.d",
    w: "task.repeatEvery.w",
    m: "task.repeatEvery.m",
    y: "task.repeatEvery.y",
  } as const)[interval.unit];
  return message(key, { count: interval.count });
}

/** The unit's own name, for the interval editor's own choice list. */
export function repeatUnitLabel(unit: RepeatInterval["unit"], message: MessageFunction): string {
  return message(({
    d: "task.repeatUnit.d",
    w: "task.repeatUnit.w",
    m: "task.repeatUnit.m",
    y: "task.repeatUnit.y",
  } as const)[unit]);
}
