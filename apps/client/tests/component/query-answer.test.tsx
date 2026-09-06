import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { BuiltQueryResult, RdfTerm } from "../../src/generated/core-port";
import { EMPTY_SNAPSHOT } from "../../src/core-port/snapshot";
import { initialQueryView } from "../../src/entities/query-document";
import { CellValue, resultViewRows, type CellContext } from "../../src/features/query/cells";
import { resultColumns } from "../../src/features/query/QueryPanel";

const text = (value: string): RdfTerm => ({
  kind: "literal",
  value,
  datatype: "http://www.w3.org/2001/XMLSchema#string",
});
const context: CellContext = {
  snapshot: EMPTY_SNAPSHOT,
  message: ((key: string) => key) as CellContext["message"],
  formatDate: (value) => value,
  formatTime: (value) => value,
  compare: (left, right) => left.localeCompare(right),
};
const answer: BuiltQueryResult = {
  kind: "built",
  grain: "entity",
  subject: "block",
  columns: [
    { id: "q_제목", label: "Original title", source: { kind: "content" } },
    { id: "tags", source: { kind: "tags" } },
  ],
  rows: [
    {
      subject: { kind: "block", owner: { kind: "page", id: "p" }, id: "b" },
      values: {
        q_제목: [text("Before")],
        tags: [
          { kind: "iri", value: "urn:tag:a", entity: { kind: "tag", id: "a" } },
          { kind: "iri", value: "urn:tag:b", entity: { kind: "tag", id: "b" } },
        ],
      },
    },
  ],
  revision: 3,
  frontier: "three",
};

describe("executed query answers", () => {
  it("keeps links in a read-only content result outside its open control", () => {
    const onOpen = vi.fn();
    const columns = resultColumns(answer, initialQueryView(""), context.message);
    render(
      <CellValue
        terms={[text("Read [source](https://example.com)")]}
        column={columns[0]}
        subject={answer.rows[0].subject ?? undefined}
        context={{ ...context, onOpen }}
      />,
    );
    const link = screen.getByRole("link", { name: "source" });
    expect(link.closest("button")).toBeNull();
    fireEvent.click(link);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("reads stable column ids and authored labels directly from the executed descriptor", () => {
    const columns = resultColumns(answer, initialQueryView(""), context.message);
    expect(columns.map((column) => column.variable)).toEqual(["q_제목", "tags"]);
    expect(columns[0]).toMatchObject({ label: "Original title", source: { kind: "content" } });
    const rows = resultViewRows(answer);
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toEqual(answer.rows[0].subject);
    expect(rows[0].values.tags).toHaveLength(2);
  });

  it("keeps each repeated reference navigable without splitting encoded strings", () => {
    const onOpen = vi.fn();
    const columns = resultColumns(answer, initialQueryView(""), context.message);
    render(
      <CellValue
        terms={answer.rows[0].values.tags}
        column={columns[1]}
        context={{ ...context, onOpen }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "b" }));
    expect(onOpen).toHaveBeenCalledWith({ kind: "tag", id: "b" });

    const { container } = render(
      <CellValue
        terms={[text("left\u001fright"), text("other")]}
        column={columns[0]}
        context={context}
      />,
    );
    expect(container.textContent).toBe("left\u001fright, other");
  });

  it("does not grant authored provenance to raw variables with compiler-like names", () => {
    const raw = {
      kind: "select" as const,
      variables: ["q_subject", "q_제목"],
      rows: [{ q_subject: answer.rows[0].values.tags[0], q_제목: text("Raw") }],
      revision: 3,
      frontier: "three",
    };
    const columns = resultColumns(raw, initialQueryView(""), context.message);
    expect(columns.map((column) => column.variable)).toEqual(raw.variables);
    expect(columns.every((column) => column.source === undefined)).toBe(true);
    expect(resultViewRows(raw)[0].subject).toBeUndefined();
  });

  it("keeps summary rows without editable entity identity", () => {
    const summary: BuiltQueryResult = {
      ...answer,
      grain: "summary",
      columns: [{ id: "count", source: { kind: "subject" }, aggregate: "count" }],
      rows: [{ subject: null, values: { count: [text("2")] } }],
    };
    expect(resultViewRows(summary)[0].subject).toBeUndefined();
    expect(resultColumns(summary, initialQueryView(""), context.message)[0]).toMatchObject({
      aggregate: "count",
      numeric: true,
    });
  });

  it("renders a count of tags as a number and a minimum date as a date", () => {
    const result: BuiltQueryResult = {
      ...answer,
      grain: "summary",
      columns: [
        { id: "count", source: { kind: "tags" }, aggregate: "count" },
        { id: "date", source: { kind: "property", key: "user.date" }, aggregate: "min" },
      ],
      rows: [
        {
          subject: null,
          values: {
            count: [
              { kind: "literal", value: "2", datatype: "http://www.w3.org/2001/XMLSchema#integer" },
            ],
            date: [
              {
                kind: "literal",
                value: "2026-09-05",
                datatype: "http://www.w3.org/2001/XMLSchema#date",
              },
            ],
          },
        },
      ],
    };
    const columns = resultColumns(result, initialQueryView(""), context.message);
    const { container } = render(
      <>
        <CellValue terms={result.rows[0].values.count} column={columns[0]} context={context} />
        <CellValue
          terms={result.rows[0].values.date}
          column={columns[1]}
          context={{ ...context, formatDate: () => "September 5" }}
        />
      </>,
    );
    expect(container.querySelector(".query-num")).toHaveTextContent("2");
    expect(container.querySelector(".query-tags")).toBeNull();
    expect(container).toHaveTextContent("September 5");
  });
});
