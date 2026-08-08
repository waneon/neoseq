// Localized names for the registry's suggested task values. A stored value
// outside the suggested set is shown verbatim — it is the user's own word.

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
