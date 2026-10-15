// Graph-defined properties filter as the type they are stored with.

import { expect, it } from "vitest";
import { defaultPlan, newCondition } from "../../src/entities/query-plan";
import type {
  BuiltQueryResult,
  PlanColumn,
  PlanField,
  PlanOperator,
  PlanValue,
} from "../../src/generated/core-port";
import { mountTypedGraph } from "./query-graph-properties";

const property = (key: string): PlanField => ({ kind: "property", key });

it("filters by each graph-defined property type", async () => {
  const { session, block, child } = await mountTypedGraph();
  const matching = async (
    field: PlanField,
    op: PlanOperator,
    value?: PlanValue,
    value2?: PlanValue,
  ) => {
    const plan = defaultPlan("block");
    plan.where.children = [{ ...newCondition(field), op, value, value2 }];
    const result = (await session.query({
      kind: "built",
      plan,
      today: "2026-01-05",
    })) as BuiltQueryResult;
    return result.rows.map((row) =>
      row.subject?.id === block ? "first" : row.subject?.id === child ? "second" : "?",
    );
  };
  expect(await matching(property("user.text"), "equals", { type: "text", value: "Abc" })).toEqual([
    "first",
  ]);
  expect(await matching(property("user.estimate"), "equals", { type: "number", value: 3 })).toEqual(
    ["first"],
  );
  // A negative comparison needs a value to compare: "second" has no estimate.
  expect(
    await matching(property("user.estimate"), "not_equals", { type: "number", value: 3 }),
  ).toEqual([]);
  expect(
    await matching(property("user.estimate"), "not_equals", { type: "number", value: 4 }),
  ).toEqual(["first"]);
  expect(
    await matching(property("user.text"), "not_contains", { type: "text", value: "x" }),
  ).toEqual(["first"]);
  expect(await matching(property("user.done"), "is_false")).toEqual([]);
  expect(await matching(property("user.estimate"), "is_empty")).toEqual(["second"]);
  expect(
    await matching(
      property("user.estimate"),
      "between",
      { type: "number", value: 1 },
      { type: "number", value: 5 },
    ),
  ).toEqual(["first"]);
  expect(await matching(property("user.due"), "lt", { type: "date", value: "2026-01-03" })).toEqual(
    ["first"],
  );
  expect(
    await matching(property("user.due"), "gt", {
      type: "relative",
      value: { unit: "day", offset: -10 },
    }),
  ).toEqual(["first"]);
  expect(await matching(property("user.done"), "is_true")).toEqual(["first"]);
  expect(await matching(property("user.link"), "equals", { type: "page", value: "other" })).toEqual(
    ["first"],
  );
  expect(
    await matching(property("user.link"), "any_of", { type: "list", values: ["other"] }),
  ).toEqual(["first"]);
});
