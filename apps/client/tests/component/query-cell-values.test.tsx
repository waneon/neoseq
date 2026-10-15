// A cell reads a value by its own type.

import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { EMPTY_SNAPSHOT } from "../../src/core-port/snapshot";
import { CellValue, type CellContext, type ResultColumn } from "../../src/features/query/cells";

const context: CellContext = {
  snapshot: EMPTY_SNAPSHOT,
  message: ((key: string) => key) as CellContext["message"],
  formatDate: (value) => value,
  formatTime: (value) => value,
  compare: (left, right) => left.localeCompare(right),
};
const column = (patch: Partial<ResultColumn>): ResultColumn => ({
  variable: "v",
  label: "v",
  ordering: { kind: "text" },
  sortable: true,
  numeric: false,
  width: null,
  source: { kind: "property", key: "user.done" },
  ...patch,
});

it("shows a graph-defined checkbox as a check", () => {
  const { container } = render(
    <CellValue
      terms={[
        { kind: "literal", value: "true", datatype: "http://www.w3.org/2001/XMLSchema#boolean" },
      ]}
      column={column({})}
      context={context}
    />,
  );
  expect(container.querySelector(".query-check")).toHaveTextContent("properties.checked");
});
