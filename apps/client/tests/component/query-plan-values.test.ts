import { describe, expect, it } from "vitest";
import { valueForOperator, type PlanField } from "../../src/entities/query-plan";

const status: PlanField = { kind: "property", key: "builtin.task-status" };
const tag: PlanField = { kind: "tag" };

describe("a condition's value across operators", () => {
  it("carries a chosen value into a list and back", () => {
    const doing = { type: "text", value: "doing" } as const;
    expect(valueForOperator("any_of", status, doing)).toEqual({ type: "list", values: ["doing"] });
    expect(valueForOperator("equals", status, { type: "list", values: ["doing", "todo"] })).toEqual(
      doing,
    );
    expect(valueForOperator("any_of", tag, { type: "tag", value: "" })).toEqual({
      type: "list",
      values: [],
    });
    expect(valueForOperator("equals", tag, { type: "list", values: ["t1"] })).toEqual({
      type: "tag",
      value: "t1",
    });
  });

  it("gives operators without a value none, and fills an emptied list's field default", () => {
    expect(valueForOperator("is_set", status, { type: "text", value: "doing" })).toBeUndefined();
    expect(valueForOperator("equals", tag, { type: "list", values: [] })).toEqual({
      type: "tag",
      value: "",
    });
  });
});
