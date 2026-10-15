// A graph whose block carries one property of each graph-defined type.

import { GRAPH_ID, mountAt, type Harness } from "./harness";

export const OWNER = { kind: "page", id: "home" } as const;

export async function mountTypedGraph(): Promise<Harness & { block: string; child: string }> {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  const { block, child } = await harness.settle(async () => {
    const { session } = harness;
    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await session.execute({ type: "ensure_page", page_id: "other", title: "Other" });
    const block = (
      await session.execute({
        type: "insert_block",
        owner: OWNER,
        parent: null,
        index: 0,
        markdown: "first",
      })
    ).created_block!;
    const child = (
      await session.execute({
        type: "insert_block",
        owner: OWNER,
        parent: block,
        index: 0,
        markdown: "second",
      })
    ).created_block!;
    for (const [key, value] of [
      ["user.text", { type: "string", value: "Abc" }],
      ["user.estimate", { type: "number", value: 3 }],
      ["user.due", { type: "date", value: "2026-01-02" }],
      ["user.done", { type: "checkbox", value: true }],
      ["user.link", { type: "page", value: "other" }],
    ] as const) {
      await session.execute({
        type: "set_property",
        owner: { kind: "block", owner: OWNER, id: block },
        key,
        value,
      });
    }
    return { block, child };
  });
  return { ...harness, block, child };
}
