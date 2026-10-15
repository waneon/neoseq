// A number is more or less than another; only a date comes before or after.

import { expect, it } from "vitest";
import { EMPTY_SNAPSHOT } from "../../src/core-port/snapshot";
import { columnLabel } from "../../src/features/query/labels";
import { conditionPhrase } from "../../src/features/query/summary";
import { createLocaleRuntime } from "../../src/i18n";

it("words ordering and extremes by the field's type", () => {
  const { message } = createLocaleRuntime("en");
  const snapshot = {
    ...EMPTY_SNAPSHOT,
    pages: [
      {
        id: "home",
        title: "Home",
        tags: [],
        blocks: [],
        properties: [
          {
            key: "user.estimate",
            value_type: "number" as const,
            cardinality: "single" as const,
            values: [],
          },
        ],
      },
    ],
  };
  const context = { snapshot, message, formatDate: (date: string) => date };
  const phrase = (
    key: string,
    value: { type: "number"; value: number } | { type: "date"; value: string },
  ) =>
    conditionPhrase(
      { id: "c", kind: "condition", field: { kind: "property", key }, op: "gt", value },
      "block",
      context,
    ).operator;
  expect(phrase("builtin.task-deadline", { type: "date", value: "2026-01-01" })).toBe("is after");
  expect(phrase("user.estimate", { type: "number", value: 8 })).toBe("is more than");
  const types = new Map([["user.estimate", "number" as const]]);
  const estimate = { kind: "property", key: "user.estimate" } as const;
  expect(
    columnLabel({ id: "m", source: estimate, aggregate: "max" }, "block", message, types),
  ).toBe("largest estimate");
  expect(
    columnLabel(
      { id: "m", source: { kind: "property", key: "builtin.task-deadline" }, aggregate: "max" },
      "block",
      message,
    ),
  ).toMatch(/^latest /);
});
