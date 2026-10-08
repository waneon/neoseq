// Shared fixtures for the query builder and query result suites.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import { type ReactElement } from "react";
import {
  findBlock,
  findPage,
  queryDocument,
  type PropertyDocument,
} from "../../src/core-port/snapshot";
import { GRAPH_ID, mountAt } from "./harness";
import type { Harness } from "./harness";

export interface PageHarness extends Harness {
  queryBlockId: string;
}

export interface ResultHarness extends PageHarness {
  resultBlockId: string;
}

export function createdBlock(result: { created_block: string | null }): string {
  if (!result.created_block) throw new Error("insert_block returned no block id");
  return result.created_block;
}

export async function mountPage(custom?: ReactElement): Promise<PageHarness> {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`, custom);
  // Most builder tests describe the question, not a live graph answer. Make
  // that fixture boundary explicit now that the test port otherwise runs the
  // real query engine.
  harness.port.queryResult = {
    kind: "built",
    grain: "entity",
    subject: "block",
    columns: [],
    rows: [],
    revision: 0,
    frontier: "query-builder-empty",
  };
  const inserted = await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    return harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "",
    });
  });
  return { ...harness, queryBlockId: createdBlock(inserted) };
}

export function storedQuery(harness: Harness): PropertyDocument | undefined {
  const block = harness.session.getState().snapshot.pages[0]?.blocks[0];
  return block && queryDocument(block.properties);
}

export function activeDefinition(document: PropertyDocument) {
  return (
    document.views.find((view) => view.id === document.default_view_id)?.definition ??
    document.views[0].definition
  );
}

export function storedDefinition(harness: Harness) {
  const document = storedQuery(harness);
  return document ? activeDefinition(document) : undefined;
}

/**
 * The newest execution of an authored plan. Other mounted surfaces (references,
 * standing questions) run their own raw queries on their own schedule, so the
 * overall last request is not this query's.
 */
export function lastBuiltQuery(harness: Harness) {
  return harness.port.queryRequests.filter(({ query }) => query.kind === "built").at(-1)?.query;
}

/** Creates a query through the slash menu. */
export async function createQuery(harness: Harness): Promise<void> {
  const user = userEvent.setup();
  const textarea = await screen.findByLabelText("Block text");
  await user.click(textarea);
  await user.type(textarea, "/query");
  const menu = await screen.findByTestId("slash-menu");
  await harness.settle(() => fireEvent.click(within(menu).getByRole("option", { name: /^Query/ })));
  await screen.findByTestId("query-builder");
  await waitFor(() => expect(storedDefinition(harness)?.plan).toBeTruthy());
  // Slash completion restores the source caret after canonical publication.
  await harness.settle(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())),
  );
}

export async function withResult(
  markdown = "Ship the builder",
  custom?: ReactElement,
): Promise<ResultHarness> {
  const harness = await mountPage(custom);
  await createQuery(harness);
  // The core chooses block identities. Insert first to learn that identity,
  // then make the final edit after installing the query answer so ordinary
  // canonical invalidation observes the injected row.
  const inserted = await harness.settle(() =>
    harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 1,
      markdown: "Preparing result",
    }),
  );
  const resultBlockId = createdBlock(inserted);
  harness.port.queryResult = {
    kind: "built",
    grain: "entity",
    subject: "block",
    columns: [
      { id: "text", source: { kind: "content" } },
      { id: "page", source: { kind: "page" } },
    ],
    rows: [
      {
        subject: {
          kind: "block",
          owner: { kind: "page", id: "home" },
          id: resultBlockId,
        },
        values: {
          text: [
            {
              kind: "literal",
              value: markdown,
              datatype: "http://www.w3.org/2001/XMLSchema#string",
            },
          ],
          page: [
            {
              kind: "iri",
              value: "urn:neoseq:entity:test-graph:page:home",
              entity: { kind: "page", id: "home" },
            },
          ],
        },
      },
    ],
    revision: 4,
    frontier: "fixture-4",
  };
  await harness.settle(() =>
    harness.session.execute({
      type: "edit_markdown",
      owner: { kind: "page", id: "home" },
      block_id: resultBlockId,
      markdown,
    }),
  );
  return { ...harness, resultBlockId };
}

export function resultBlock(harness: ResultHarness) {
  const page = findPage(harness.session.getState().snapshot, "home");
  return page ? findBlock(page, harness.resultBlockId) : undefined;
}

export async function addSecondResult(harness: ResultHarness) {
  const inserted = await harness.session.execute({
    type: "insert_block",
    owner: { kind: "page", id: "home" },
    parent: null,
    index: 2,
    markdown: "Preparing second result",
  });
  const id = createdBlock(inserted);
  const result = harness.port.queryResult;
  if (result?.kind !== "built") throw new Error("expected built fixture");
  harness.port.queryResult = {
    ...result,
    rows: [
      ...result.rows,
      {
        subject: { kind: "block", owner: { kind: "page", id: "home" }, id },
        values: {
          ...result.rows[0].values,
          text: [
            {
              kind: "literal",
              value: "Second result",
              datatype: "http://www.w3.org/2001/XMLSchema#string",
            },
          ],
        },
      },
    ],
    revision: result.revision + 1,
    frontier: "fixture-second-result",
  };
  await harness.session.execute({
    type: "edit_markdown",
    owner: { kind: "page", id: "home" },
    block_id: id,
    markdown: "Second result",
  });
  await waitFor(() =>
    expect(
      within(screen.getByTestId("query-table")).getAllByTestId("query-edit-text"),
    ).toHaveLength(2),
  );
}
