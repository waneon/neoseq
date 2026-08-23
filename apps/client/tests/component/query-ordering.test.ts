import { describe, expect, it } from "vitest";
import type { RdfTerm } from "../../src/generated/core-port";
import { EMPTY_SNAPSHOT } from "../../src/core-port/snapshot";
import {
  inferOrderSemantics,
  orderSemanticsForColumn,
  orderSemanticsForField,
} from "../../src/entities/query-ordering";
import type {
  CellContext,
  ResultColumn,
  ResultViewRow,
} from "../../src/features/query/cells";
import {
  compareResultTerms,
  orderBlockRows,
  orderResultRows,
} from "../../src/features/query/ordering";

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
  // Array.prototype.sort special-cases undefined array elements and moves them
  // to the end without calling the comparator. Real query rows are always
  // objects whose term may be undefined, so wrap terms to exercise that path.
  return values.map((term) => ({ term }))
    .sort((left, right) => {
      const comparison = compareResultTerms(
        left.term,
        right.term,
        semantics,
        context,
        descending,
      );
      return descending ? -comparison : comparison;
    })
    .map(({ term }) => term?.value);
}

describe("query column ordering", () => {
  it("derives ranked choices and typed primitives from column semantics", () => {
    expect(orderSemanticsForColumn({
      source: { kind: "property", key: "builtin.task-priority" },
    })).toEqual({
      kind: "ranked",
      values: ["low", "medium", "high"],
      missing: "below",
    });
    expect(orderSemanticsForColumn({
      source: { kind: "property", key: "builtin.task-status" },
    })).toEqual({
      kind: "ranked",
      values: ["todo", "doing", "done", "cancelled"],
      missing: "last",
    });
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

  it("orders missing priority below Low while keeping open-choice fallbacks last", () => {
    const values = [undefined, string("urgent"), string("high"), string("low")];
    expect(sorted(values)).toEqual([undefined, "low", "high", "urgent"]);
    expect(sorted(values, true)).toEqual(["high", "low", undefined, "urgent"]);
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

  it("applies saved terms in precedence order before a renderer sees rows", () => {
    const columns: ResultColumn[] = [
      {
        variable: "group",
        label: "Group",
        ordering: { kind: "text" },
        sortable: true,
        numeric: false,
        width: null,
      },
      {
        variable: "rank",
        label: "Rank",
        ordering: { kind: "number" },
        sortable: true,
        numeric: true,
        width: null,
      },
    ];
    const row = (key: string, group: string, rank: string): ResultViewRow => ({
      key,
      values: {
        group: string(group),
        rank: { kind: "literal", value: rank, datatype: `${XSD}integer` },
      },
    });
    const rows = [row("b", "B", "3"), row("a1", "A", "1"), row("a2", "A", "2")];

    expect(orderResultRows(rows, [
      { variable: "group", descending: false },
      { variable: "rank", descending: true },
    ], columns, context).map((item) => item.key)).toEqual(["a2", "a1", "b"]);
    expect(rows.map((item) => item.key)).toEqual(["b", "a1", "a2"]);
  });

  it("orders canonical blocks by a repeated field absent from the result projection", () => {
    const property = (values: string[]) => ({
      key: "user.owner",
      value_type: "string" as const,
      cardinality: "set" as const,
      values: values.map((value) => ({ type: "string" as const, value })),
    });
    const block = (id: string, values?: string[]) => ({
      id,
      markdown: id,
      properties: values ? [property(values)] : [],
      tags: [],
      children: [],
    });
    const snapshot = {
      ...EMPTY_SNAPSHOT,
      graph_id: "g",
      pages: [{
        id: "home",
        title: "Home",
        properties: [],
        tags: [],
        blocks: [block("b1", ["Beta", "Zulu"]), block("b2", ["Alpha"]), block("b3")],
      }],
    };
    const blockContext = { ...context, snapshot };
    const row = (id: string): ResultViewRow => ({
      key: id,
      values: {},
      subject: { kind: "block", owner: { kind: "page", id: "home" }, id },
    });
    const rows = [row("b1"), row("b3"), row("b2")];
    const field = { kind: "property" as const, key: "user.owner" };
    const fields = [{
      id: "property:user.owner",
      field,
      ordering: orderSemanticsForField(field),
    }];

    expect(orderBlockRows(rows, [
      { field: "property:user.owner", descending: false },
    ], fields, blockContext).map((item) => item.key)).toEqual(["b2", "b1", "b3"]);
    expect(orderBlockRows(rows, [
      { field: "property:user.owner", descending: true },
    ], fields, blockContext).map((item) => item.key)).toEqual(["b1", "b2", "b3"]);
    expect(rows.map((item) => item.key)).toEqual(["b1", "b3", "b2"]);
  });
});
