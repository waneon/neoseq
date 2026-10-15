import type { Command, PropertyChange } from "../../core-port/commands";
import {
  dateValue,
  stringValue,
  type BlockSnapshot,
  type OutlineOwner,
} from "../../core-port/snapshot";
import {
  advanceDate,
  parseRepeat,
  TASK_DEADLINE_KEY,
  TASK_REPEAT_KEY,
  TASK_SCHEDULED_KEY,
  TASK_STATUS_KEY,
} from "../../entities/tasks";

const TASK_CYCLE = [undefined, "todo", "doing", "done"] as const;

/** Where a recurring task's next occurrence falls, or nothing if it does not recur. */
export function nextOccurrence(block: BlockSnapshot): string | undefined {
  const repeat = parseRepeat(stringValue(block.properties, TASK_REPEAT_KEY) ?? "");
  const date =
    dateValue(block.properties, TASK_SCHEDULED_KEY) ??
    dateValue(block.properties, TASK_DEADLINE_KEY);
  return repeat && date !== undefined ? advanceDate(date, repeat) : undefined;
}

/**
 * Gives a task `status`. Completing a recurring task completes one occurrence:
 * its dates roll forward and it stays open, in one property transition.
 * Removing the status removes only the status; other task facts remain.
 */
export function taskStatusCommand(
  owner: OutlineOwner,
  block: BlockSnapshot,
  status: string | undefined,
): Command {
  const entity = { kind: "block", owner, id: block.id } as const;
  if (status === undefined) return { type: "remove_property", owner: entity, key: TASK_STATUS_KEY };
  const repeat = parseRepeat(stringValue(block.properties, TASK_REPEAT_KEY) ?? "");
  if (status === "done" && repeat && nextOccurrence(block) !== undefined) {
    const changes: PropertyChange[] = [];
    for (const key of [TASK_SCHEDULED_KEY, TASK_DEADLINE_KEY]) {
      const date = dateValue(block.properties, key);
      if (date !== undefined) {
        changes.push({ key, value: { type: "date", value: advanceDate(date, repeat) } });
      }
    }
    if (stringValue(block.properties, TASK_STATUS_KEY) !== "todo") {
      changes.push({ key: TASK_STATUS_KEY, value: { type: "string", value: "todo" } });
    }
    return { type: "set_properties", owner: entity, changes };
  }
  return {
    type: "set_property",
    owner: entity,
    key: TASK_STATUS_KEY,
    value: { type: "string", value: status },
  };
}

export function cycleTaskCommand(owner: OutlineOwner, block: BlockSnapshot, steps = 1): Command {
  const status = stringValue(block.properties, TASK_STATUS_KEY);
  const current = TASK_CYCLE.findIndex((value) => value === status);
  return taskStatusCommand(
    owner,
    block,
    TASK_CYCLE[(Math.max(current, 0) + steps) % TASK_CYCLE.length],
  );
}

export function isTaskCycleKey(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  return (
    event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey
  );
}
