import { describe, expect, it } from "vitest";
import type { RdfTerm } from "../../src/generated/core-port";
import { EMPTY_SNAPSHOT } from "../../src/core-port/snapshot";
import {
  inferOrderSemantics,
  orderSemanticsForColumn,
} from "../../src/entities/query-ordering";
import type { CellContext } from "../../src/features/query/cells";
import { compareResultTerms } from "../../src/features/query/ordering";

const XSD = "http://www.w3.org/2001/XMLSchema#";
const context: CellContext = {
  snapshot: EMPTY_SNAPSHOT,
  message: ((key: string) => key) as CellContext["message"],
  formatDate: (value) => value,
  compare: new Intl.Collator("ko", {
    usage: "sort",
    sensitivity: "base",
    numeric: true,
  }).compare,
};

function string(value: string): RdfTerm {
  return { kind: "literal", value, datatype: `${XSD}string` };
}

function sorted(
  values: Array<RdfTerm | undefined>,
  descending = false,
): Array<string | undefined> {
  const semantics = orderSemanticsForColumn({
    source: { kind: "property", key: "builtin.task-priority" },
  });
  return [...values]
    .sort((left, right) => {
      const comparison = compareResultTerms(left, right, semantics, context, descending);
      return descending ? -comparison : comparison;
    })
    .map((term) => term?.value);
}

describe("query column ordering", () => {
  it("derives ranked choices and typed primitives from column semantics", () => {
    expect(orderSemanticsForColumn({
      source: { kind: "property", key: "builtin.task-priority" },
    })).toEqual({ kind: "ranked", values: ["low", "medium", "high"] });
    expect(orderSemanticsForColumn({
      source: { kind: "property", key: "builtin.task-status" },
    })).toEqual({ kind: "ranked", values: ["todo", "doing", "done", "cancelled"] });
    expect(orderSemanticsForColumn({ source: { kind: "sibling_index" } }))
      .toEqual({ kind: "number" });
    expect(orderSemanticsForColumn({ source: { kind: "tags" }, aggregate: "list" }))
      .toEqual({ kind: "unsupported_list" });
  });

  it("orders stored priority values by rank, independent of Korean labels", () => {
    const values = [string("high"), string("low"), string("medium")];
    expect(sorted(values)).toEqual(["low", "medium", "high"]);
    expect(sorted(values, true)).toEqual(["high", "medium", "low"]);
  });

  it("keeps open-choice fallbacks and missing values after declared choices", () => {
    const values = [undefined, string("urgent"), string("high"), string("low")];
    expect(sorted(values)).toEqual(["low", "high", "urgent", undefined]);
    expect(sorted(values, true)).toEqual(["high", "low", "urgent", undefined]);
  });

  it("infers typed order for hand-written SPARQL results", () => {
    const terms = ["10", "2"].map((value) => ({
      kind: "literal" as const,
      value,
      datatype: `${XSD}integer`,
    }));
    const semantics = inferOrderSemantics(terms);
    expect(semantics).toEqual({ kind: "number" });
    expect([...terms].sort((left, right) =>
      compareResultTerms(left, right, semantics, context, false)).map((term) => term.value))
      .toEqual(["2", "10"]);
  });
});
