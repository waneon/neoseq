import type { Command } from "../../core-port/commands";
import { stringValue, type BlockSnapshot, type OutlineOwner } from "../../core-port/snapshot";
import { TASK_STATUS_KEY } from "../../entities/tasks";

const TASK_CYCLE = [undefined, "todo", "doing", "done"] as const;

/** Cycling removes only the status; other task facts remain available. */
export function cycleTaskCommand(owner: OutlineOwner, block: BlockSnapshot, steps = 1): Command {
  const status = stringValue(block.properties, TASK_STATUS_KEY);
  const current = TASK_CYCLE.findIndex((value) => value === status);
  const next = TASK_CYCLE[(Math.max(current, 0) + steps) % TASK_CYCLE.length];
  const entity = { kind: "block", owner, id: block.id } as const;
  return next === undefined
    ? { type: "remove_property", owner: entity, key: TASK_STATUS_KEY }
    : {
        type: "set_property",
        owner: entity,
        key: TASK_STATUS_KEY,
        value: { type: "string", value: next },
      };
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
