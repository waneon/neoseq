// A row edited out of the answer stays where the reader is writing in it.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it } from "vitest";
import { createdBlock, createQuery, mountPage } from "./query-support";

const owner = { kind: "page", id: "home" } as const;

function answer(blocks: { id: string; text: string }[], revision: number) {
  return {
    kind: "built" as const,
    subject: "block" as const,
    columns: [{ id: "text", source: { kind: "content" as const } }],
    rows: blocks.map(({ id, text }) => ({
      subject: { kind: "block" as const, owner, id },
      values: {
        text: [
          {
            kind: "literal" as const,
            value: text,
            datatype: "http://www.w3.org/2001/XMLSchema#string",
          },
        ],
      },
    })),
    revision,
    frontier: `fixture-${revision}`,
  };
}

it("keeps the edited row between its neighbours when it stops matching", async () => {
  const harness = await mountPage();
  await createQuery(harness);
  const blocks: { id: string; text: string }[] = [];
  for (const [index, text] of ["apple one", "apple two", "apple three"].entries()) {
    const inserted = await harness.settle(() =>
      harness.session.execute({
        type: "insert_block",
        owner,
        parent: null,
        index: index + 1,
        markdown: text,
      }),
    );
    blocks.push({ id: createdBlock(inserted), text });
  }
  harness.port.queryResult = answer(blocks, 4);
  await harness.settle(() =>
    harness.session.execute({
      type: "edit_markdown",
      owner,
      block_id: blocks[0].id,
      markdown: "apple one",
    }),
  );
  const table = await screen.findByTestId("query-table");
  await waitFor(() => expect(within(table).getAllByTestId("query-row")).toHaveLength(3));
  await userEvent.setup().click(within(table).getAllByTestId("query-edit-text")[1]);
  await screen.findByTestId("query-markdown-editor");

  harness.port.queryResult = answer([blocks[0], blocks[2]], 5);
  await harness.settle(() =>
    harness.session.execute({
      type: "set_property",
      owner: { kind: "block", owner, id: blocks[1].id },
      key: "user.check",
      value: { type: "string", value: "changed" },
    }),
  );
  await waitFor(() =>
    expect(within(table).getAllByTestId("query-row")[1]).toHaveAttribute("data-pinned", "true"),
  );
});
