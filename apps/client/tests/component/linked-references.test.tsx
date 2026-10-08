import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { QueryFrame } from "../../src/core-port/session";
import type { AuthoredQueryRequest } from "../../src/generated/core-port";
import { GRAPH_ID, mountAt } from "./harness";

describe("linked references", () => {
  it("finds semantic page links in unloaded outlines, deduplicates them, and opens their block", async () => {
    const { session, router, settle } = await mountAt(`/g/${GRAPH_ID}/custom`);
    await session.execute({ type: "ensure_page", page_id: "target", title: "Target" });
    await session.execute({ type: "ensure_page", page_id: "source", title: "Source" });
    const owner = { kind: "page", id: "source" } as const;
    const inserted = await session.execute({
      type: "insert_block",
      owner,
      parent: null,
      index: 0,
      markdown: "See ",
    });
    await session.execute({
      type: "splice_block_content",
      owner,
      block_id: inserted.created_block!,
      index: 4,
      delete: 0,
      insert: [{ type: "page_reference", page_id: "target" }],
    });
    await session.execute({
      type: "set_property",
      owner: { kind: "block", owner, id: inserted.created_block! },
      key: "user.related",
      value: { type: "page", value: "target" },
    });
    await session.execute({
      type: "insert_block",
      owner,
      parent: null,
      index: 1,
      markdown: "Unresolved [[Target]]",
    });
    await settle(() => router.navigate(`/g/${GRAPH_ID}/p/target`));
    const references = await screen.findByTestId("linked-references");
    expect(within(references).getAllByTestId("linked-reference")).toHaveLength(1);
    expect(references).toHaveTextContent("See [[Target]]");
    expect(references).not.toHaveTextContent("Unresolved");
    const openBlock = within(references).getByRole("button", { name: "Open block" });
    const user = userEvent.setup();
    await settle(() => openBlock.focus());
    await settle(() => user.tab());
    expect(router.state.location.pathname).toBe(`/g/${GRAPH_ID}/p/target`);
    expect(within(references).getByTestId("block-markdown")).not.toHaveAttribute("tabindex");
    // The reveal lasts 220 ms. Loading the destination must not spend that
    // interval merely because other tests are competing for CPU time.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      await settle(() => fireEvent.click(openBlock));
      expect(router.state.location.pathname).toBe(`/g/${GRAPH_ID}/p/source`);
      const targetBlock = screen.getByDisplayValue("See [[Target]]").closest('[role="treeitem"]');
      expect(targetBlock).toHaveAttribute("data-block-id", inserted.created_block!);
      expect(targetBlock).toHaveAttribute("data-revealed", "true");
      await settle(() => vi.runOnlyPendingTimersAsync());
      expect(targetBlock).not.toHaveAttribute("data-revealed");
    } finally {
      vi.useRealTimers();
    }
  });

  it("lists page properties and tag-owned block links and refreshes after removal", async () => {
    const { session, router, settle } = await mountAt(`/g/${GRAPH_ID}/custom`);
    await session.execute({ type: "ensure_page", page_id: "target", title: "Target" });
    await session.execute({ type: "ensure_page", page_id: "source", title: "Source" });
    await session.execute({ type: "ensure_tag", tag_id: "ideas", name: "Ideas" });
    const owner = { kind: "tag", id: "ideas" } as const;
    const block = await session.execute({
      type: "insert_block",
      owner,
      parent: null,
      index: 0,
      markdown: "Tag note",
    });
    for (const source of [
      { kind: "page", id: "source" } as const,
      { kind: "block", owner, id: block.created_block! } as const,
    ]) {
      await session.execute({
        type: "set_property",
        owner: source,
        key: "user.related",
        value: { type: "page", value: "target" },
      });
    }
    await settle(() => router.navigate(`/g/${GRAPH_ID}/p/target`));
    const references = await screen.findByTestId("linked-references");
    expect(within(references).getAllByTestId("linked-reference")).toHaveLength(2);
    expect(references).toHaveTextContent("Ideas");
    expect(references).toHaveTextContent("Tag note");
    await settle(() =>
      session.execute({
        type: "remove_property",
        owner: { kind: "page", id: "source" },
        key: "user.related",
      }),
    );
    await waitFor(() =>
      expect(within(references).getAllByTestId("linked-reference")).toHaveLength(1),
    );
  });

  it("lists both pages and blocks carrying a tag and excludes plain hashtag text", async () => {
    const { session, router, settle } = await mountAt(`/g/${GRAPH_ID}/custom`);
    await session.execute({ type: "ensure_tag", tag_id: "ideas", name: "Ideas" });
    await session.execute({ type: "ensure_page", page_id: "source", title: "Source" });
    const owner = { kind: "page", id: "source" } as const;
    const block = await session.execute({
      type: "insert_block",
      owner,
      parent: null,
      index: 0,
      markdown: "Tagged note",
    });
    for (const target of [owner, { kind: "block", owner, id: block.created_block! } as const]) {
      await session.execute({ type: "add_tag", entity: target, tag_id: "ideas" });
    }
    await session.execute({
      type: "insert_block",
      owner,
      parent: null,
      index: 1,
      markdown: "Plain #Ideas",
    });
    await settle(() => router.navigate(`/g/${GRAPH_ID}/t/ideas`));
    const references = await screen.findByTestId("linked-references");
    expect(within(references).getAllByTestId("linked-reference")).toHaveLength(2);
    expect(references).toHaveTextContent("Tagged note");
    expect(references).not.toHaveTextContent("Plain");
  });
});

function referenceFrame(request: AuthoredQueryRequest, offset: number, total: number): QueryFrame {
  return {
    request,
    canonicalRevision: 1,
    result: {
      kind: "select",
      variables: ["source", "content"],
      rows: Array.from({ length: Math.min(101, Math.max(0, total - offset)) }, (_, index) => ({
        source: {
          kind: "iri" as const,
          value: `urn:neoseq:entity:${GRAPH_ID}:block:${offset + index}`,
          entity: {
            kind: "block" as const,
            owner: { kind: "page" as const, id: "source" },
            id: String(offset + index),
          },
        },
        content: { kind: "literal" as const, value: `Entry ${offset + index}` },
      })),
      revision: 1,
      frontier: "fixture",
    },
  };
}

async function mountReferencePages(
  answer: (request: AuthoredQueryRequest, offset: number) => Promise<QueryFrame>,
) {
  const harness = await mountAt(`/g/${GRAPH_ID}/custom`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_page", page_id: "target", title: "Target" });
    await harness.session.execute({ type: "ensure_page", page_id: "source", title: "Source" });
  });
  const query = vi.spyOn(harness.session, "queryFrame").mockImplementation((request) => {
    if (request.kind !== "raw_sparql") throw new Error("Expected reference query");
    const offset = Number(/OFFSET (\d+)/u.exec(request.source)?.[1]);
    return answer(request, offset);
  });
  await harness.settle(() => harness.router.navigate(`/g/${GRAPH_ID}/p/target`));
  await screen.findByTestId("linked-references");
  return { ...harness, query };
}

describe("linked reference pages", () => {
  it("reads beyond the query row budget using bounded pages and holds the previous answer while loading", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = await mountReferencePages(async (request, offset) => {
      if (offset === 100) await gate;
      // Four pages, the last one partial: enough to prove bounded paging past the
      // row budget without rendering ten full pages on a slow runner.
      return referenceFrame(request, offset, 305);
    });
    const references = screen.getByTestId("linked-references");
    const next = within(references).getByRole("button", { name: "Next", exact: true });
    const previous = within(references).getByRole("button", { name: "Previous", exact: true });
    expect(references.querySelector(".linked-references-count")).toHaveTextContent("100+");
    expect(previous).toBeDisabled();
    await harness.settle(() => {
      fireEvent.click(next);
    });
    await waitFor(() => expect(harness.query).toHaveBeenCalledTimes(2));
    expect(next).toBeDisabled();
    expect(within(references).getAllByTestId("linked-reference")).toHaveLength(100);
    expect(within(references).getAllByTestId("linked-reference")[0]).toHaveTextContent("Entry 0");
    await harness.settle(() => release());
    await waitFor(() =>
      expect(within(references).getAllByTestId("linked-reference")[0]).toHaveTextContent(
        "Entry 100",
      ),
    );
    for (let offset = 200; offset <= 300; offset += 100) {
      await userEvent.setup().click(next);
      await waitFor(() =>
        expect(within(references).getAllByTestId("linked-reference")[0]).toHaveTextContent(
          `Entry ${offset}`,
        ),
      );
    }
    expect(within(references).getAllByTestId("linked-reference")).toHaveLength(5);
    expect(references.querySelector(".linked-references-count")).toBeNull();
    expect(next).toBeDisabled();
    expect(previous).toBeEnabled();
    for (const [request] of harness.query.mock.calls) {
      expect(request.kind === "raw_sparql" && request.source).toMatch(/LIMIT 101\s+OFFSET \d+/u);
    }
  });

  it.each(["empty", "error"] as const)(
    "can return from an %s later page without hiding the controls",
    async (outcome) => {
      const harness = await mountReferencePages(async (request, offset) => {
        if (offset > 0 && outcome === "error") throw new Error("Reference query failed");
        return referenceFrame(request, offset, offset === 0 ? 101 : 0);
      });
      const references = screen.getByTestId("linked-references");
      const user = userEvent.setup();
      await user.click(within(references).getByRole("button", { name: "Next", exact: true }));
      if (outcome === "error") {
        await within(references).findByRole("alert");
        expect(within(references).getAllByTestId("linked-reference")).toHaveLength(100);
      } else {
        await waitFor(() =>
          expect(within(references).queryAllByTestId("linked-reference")).toHaveLength(0),
        );
      }
      expect(within(references).getByRole("button", { name: "Next", exact: true })).toBeDisabled();
      await user.click(within(references).getByRole("button", { name: "Previous", exact: true }));
      await waitFor(() =>
        expect(within(references).getAllByTestId("linked-reference")).toHaveLength(100),
      );
      expect(references.querySelector(".linked-references-count")).toHaveTextContent("100+");
      expect(within(references).queryByRole("alert")).not.toBeInTheDocument();
      await harness.settle();
    },
  );
});
