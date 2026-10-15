// A property the graph defines is compared as the type it is stored with.

import { expect, it } from "vitest";
import { EMPTY_SNAPSHOT, type GraphSnapshot } from "../../src/core-port/snapshot";
import { orderSemanticsForField } from "../../src/entities/query-ordering";
import {
  defaultValueForField,
  graphPropertyTypes,
  operatorsFor,
} from "../../src/entities/query-plan";

const snapshot: GraphSnapshot = {
  ...EMPTY_SNAPSHOT,
  pages: [
    {
      id: "home",
      title: "Home",
      tags: [],
      properties: [
        { key: "user.estimate", value_type: "number", cardinality: "single", values: [] },
        { key: "user.reviewed", value_type: "checkbox", cardinality: "single", values: [] },
      ],
      blocks: [],
    },
  ],
};

it("offers number and checkbox comparisons for graph-defined properties", () => {
  const types = graphPropertyTypes(snapshot);
  const estimate = { kind: "property", key: "user.estimate" } as const;
  expect(operatorsFor(estimate, types)).toContain("lt");
  expect(operatorsFor(estimate, types)).not.toContain("contains");
  expect(defaultValueForField(estimate, types)).toEqual({ type: "number", value: 0 });
  expect(operatorsFor({ kind: "property", key: "user.reviewed" }, types)).toContain("is_true");
  expect(operatorsFor({ kind: "property", key: "user.unknown" }, types)).toContain("contains");
});

it("sorts graph-defined properties as their type", () => {
  const types = graphPropertyTypes(snapshot);
  const estimate = { kind: "property", key: "user.estimate" } as const;
  expect(orderSemanticsForField(estimate, types)).toEqual({ kind: "number" });
});
