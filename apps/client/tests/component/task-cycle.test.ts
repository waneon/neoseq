// Every route to "done" completes one occurrence of a recurring task.

import { expect, it } from "vitest";
import type { BlockSnapshot } from "../../src/core-port/snapshot";
import { TASK_REPEAT_KEY, TASK_SCHEDULED_KEY, TASK_STATUS_KEY } from "../../src/entities/tasks";
import { cycleTaskCommand } from "../../src/features/tasks/commands";

const owner = { kind: "page", id: "home" } as const;

function task(status: string, repeat?: string): BlockSnapshot {
  return {
    id: "task",
    content: [],
    markdown: "Water plants",
    page_references: [],
    tags: [],
    children: [],
    properties: [
      {
        key: TASK_STATUS_KEY,
        value_type: "string",
        cardinality: "single",
        values: [{ type: "string", value: status }],
      },
      {
        key: TASK_SCHEDULED_KEY,
        value_type: "date",
        cardinality: "single",
        values: [{ type: "date", value: "2026-10-20" }],
      },
      ...(repeat
        ? [
            {
              key: TASK_REPEAT_KEY,
              value_type: "string" as const,
              cardinality: "single" as const,
              values: [{ type: "string" as const, value: repeat }],
            },
          ]
        : []),
    ],
  };
}

it("rolls a recurring task forward when the cycle reaches done", () => {
  expect(cycleTaskCommand(owner, task("doing", "1w"))).toEqual({
    type: "set_properties",
    owner: { kind: "block", owner, id: "task" },
    changes: [
      { key: TASK_SCHEDULED_KEY, value: { type: "date", value: "2026-10-27" } },
      { key: TASK_STATUS_KEY, value: { type: "string", value: "todo" } },
    ],
  });
});

it("marks a one-off task done", () => {
  expect(cycleTaskCommand(owner, task("doing"))).toMatchObject({
    type: "set_property",
    key: TASK_STATUS_KEY,
    value: { type: "string", value: "done" },
  });
});
