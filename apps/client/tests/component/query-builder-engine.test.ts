// Every condition the builder offers is one the query engine accepts.

import { expect, it } from "vitest";
import {
  PLAN_SUBJECTS,
  defaultPlan,
  fieldType,
  graphPropertyKeys,
  graphPropertyTypes,
  newCondition,
  operatorTakesRange,
  operatorsFor,
  queryFieldsFor,
  valueForOperator,
} from "../../src/entities/query-plan";
import type { PlanValue } from "../../src/generated/core-port";
import { mountTypedGraph } from "./query-graph-properties";

/** A value a reader could choose for a field of `type`. */
function chosen(type: string): PlanValue {
  if (type === "number" || type === "integer") return { type: "number", value: 2 };
  if (type === "date") return { type: "date", value: "2026-01-01" };
  if (type === "page") return { type: "page", value: "other" };
  if (type === "tag") return { type: "tag", value: "topic" };
  return { type: "text", value: "abc" };
}

it("accepts every field, operator, and value shape the builder can produce", async () => {
  const { session } = await mountTypedGraph();
  const snapshot = session.getState().snapshot;
  const types = graphPropertyTypes(snapshot);
  const rejected: string[] = [];
  for (const subject of PLAN_SUBJECTS) {
    for (const field of queryFieldsFor(subject, graphPropertyKeys(snapshot))) {
      for (const op of operatorsFor(field, types)) {
        for (const start of [undefined, chosen(fieldType(field, types))]) {
          const value = valueForOperator(op, field, start, types);
          const plan = defaultPlan(subject);
          plan.where.children = [
            {
              ...newCondition(field, types),
              op,
              value,
              value2: operatorTakesRange(op) ? value : undefined,
            },
          ];
          await session
            .query({ kind: "built", plan, today: "2026-01-05" })
            .catch(() => rejected.push(`${subject} ${JSON.stringify(field)} ${op}`));
        }
      }
    }
  }
  expect(rejected).toEqual([]);
});
