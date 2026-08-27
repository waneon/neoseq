// First-class tag chips + default materialization from TagRecord defaults.

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { chooseFromMenu, GRAPH_ID, mountAt, openBlockMenu, openTagMenu, openViewMenu } from "./harness";

async function mountTagged() {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  const { session } = harness;
  await harness.settle(async () => {
    await session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await session.execute({ type: "ensure_tag", tag_id: "project", name: "Project" });
    await session.execute({
      type: "set_property",
      owner: { kind: "tag_default", tag_id: "project" },
      key: "builtin.task-status",
      value: { type: "string", value: "todo" },
    });
    await session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "existing status",
    });
  });
  await waitFor(() => expect(screen.getByTestId("page-title")).toHaveValue("Home"));
  return harness;
}

describe("first-class tags and tag defaults", () => {
  it("copies defaults on tag but never overwrites existing block values", async () => {
    const { session } = await mountTagged();
    const user = userEvent.setup();
    // The block already tracks its own status.
    await session.execute({
      type: "set_property",
      owner: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
      key: "builtin.task-status",
      value: { type: "string", value: "doing" },
    });

    await openBlockMenu();
    await user.click(await screen.findByTestId("menu-tags"));
    const picker = await screen.findByTestId("tag-picker");
    const autocomplete = within(picker).getByTestId("tag-autocomplete");
    await user.type(autocomplete, "Proj");
    await user.click(await screen.findByRole("option", { name: "Project" }));

    await waitFor(() => expect(within(picker).getByTestId("tag-chip")).toHaveTextContent("#Project"));
    // Existing value wins over the tag default.
    await waitFor(() =>
      expect(screen.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: Doing"),
    );
  });

  it("materializes missing defaults and supports chip removal", async () => {
    const { session } = await mountTagged();
    const user = userEvent.setup();
    await session.execute({
      type: "add_tag",
      entity: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
      tag_id: "project",
    });

    await openBlockMenu();
    await user.click(await screen.findByTestId("menu-tags"));
    const picker = await screen.findByTestId("tag-picker");
    // The default was copied because the block had no builtin.task-status.
    await waitFor(() =>
      expect(screen.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: To-do"),
    );

    await user.click(within(picker).getByRole("button", { name: "Remove tag Project" }));
    await waitFor(() =>
      expect(within(picker).queryByTestId("tag-chip")).not.toBeInTheDocument(),
    );
    // Copied properties are plain properties: removing the tag keeps them.
    expect(screen.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: To-do");
  });

  it("removes a deleted tag from hydrated blocks but keeps copied defaults", async () => {
    const { session } = await mountTagged();
    await session.execute({
      type: "add_tag",
      entity: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
      tag_id: "project",
    });
    expect(await screen.findByTestId("tag-chip")).toHaveTextContent("#Project");

    await session.execute({ type: "delete_tag", tag_id: "project" });

    await waitFor(() => expect(screen.queryByTestId("tag-chip")).not.toBeInTheDocument());
    expect(screen.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: To-do");
  });

  it("does not offer a duplicate tag create action", async () => {
    const { port } = await mountTagged();
    const user = userEvent.setup();
    await openBlockMenu();
    await user.click(await screen.findByTestId("menu-tags"));
    const picker = await screen.findByTestId("tag-picker");
    await user.type(within(picker).getByTestId("tag-autocomplete"), "  project  ");

    expect(await screen.findByRole("option", { name: "Project" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: /Create tag/ })).not.toBeInTheDocument();
  });

  it("keeps an autocomplete option alive through the complete pointer gesture", async () => {
    const { port } = await mountTagged();
    const user = userEvent.setup();
    await openBlockMenu();
    await user.click(await screen.findByTestId("menu-tags"));
    const picker = await screen.findByTestId("tag-picker");
    await user.type(within(picker).getByTestId("tag-autocomplete"), "Project");
    const option = await screen.findByRole("option", { name: "Project" });
    let commandStarted = false;
    port.beforeExecute = async (command) => {
      if (command.type !== "add_tag") return;
      commandStarted = true;
    };

    await user.pointer({ target: option, keys: "[MouseLeft>]" });
    expect(option).toBeInTheDocument();
    expect(commandStarted).toBe(false);

    await user.pointer({ target: option, keys: "[/MouseLeft]" });
    await waitFor(() => expect(commandStarted).toBe(true));
    await waitFor(() =>
      expect(within(picker).getByTestId("tag-chip")).toHaveTextContent("#Project"),
    );
  });

  it("cancels a stale blur dismissal when the autocomplete regains focus", async () => {
    await mountTagged();
    const user = userEvent.setup();
    await openBlockMenu();
    await user.click(await screen.findByTestId("menu-tags"));
    const picker = await screen.findByTestId("tag-picker");
    const autocomplete = within(picker).getByTestId("tag-autocomplete");
    await user.type(autocomplete, "Project");
    const option = await screen.findByRole("option", { name: "Project" });

    // An overlay launcher may restore focus while the newly opened field is
    // already taking it. Once the field wins, an earlier blur must no longer
    // be allowed to dismiss the choices underneath the reader's pointer.
    fireEvent.blur(autocomplete);
    fireEvent.focus(autocomplete);
    await new Promise((resolve) => setTimeout(resolve, 200));

    expect(option).toBeInTheDocument();
  });
});

describe("the # tag menu in a block", () => {
  it("adds an existing tag and strips the token from the Markdown", async () => {
    const { port } = await mountTagged();
    const user = userEvent.setup();
    const textarea = await screen.findByLabelText("Block text");
    const commands: Array<{ type: string; commands?: Array<{ type: string }> }> = [];
    port.beforeExecute = async (command) => { commands.push(command); };
    await user.click(textarea);
    await user.type(textarea, " #proj");
    const menu = await screen.findByTestId("tag-menu");
    expect(within(menu).getByRole("option", { name: /Project/ })).toBeVisible();
    await user.keyboard("{Enter}");

    // The token never reaches the Markdown, nor does the gap it sat behind.
    await waitFor(() => expect(textarea).toHaveValue("existing status"));
    const text = textarea.closest(".outline-text") as HTMLElement;
    await waitFor(() =>
      expect(within(text).getByTestId("tag-chip")).toHaveTextContent("#Project"),
    );
    // The tag's default materialized onto the block.
    await waitFor(() =>
      expect(screen.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: To-do"),
    );
    expect(commands).toEqual([expect.objectContaining({ type: "add_tag" })]);

    await user.keyboard("{Meta>}z{/Meta}");
    await waitFor(() => {
      expect(textarea).toHaveValue("existing status");
      expect(within(text).queryByTestId("tag-chip")).not.toBeInTheDocument();
    });
  });

  it("never offers to create a tag — a query nothing matches closes the menu", async () => {
    await mountTagged();
    const user = userEvent.setup();
    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, " #p");
    expect(await screen.findByTestId("tag-menu")).toBeVisible();
    await user.type(textarea, "zzz");
    await waitFor(() => expect(screen.queryByTestId("tag-menu")).not.toBeInTheDocument());
    expect(screen.queryByRole("option", { name: /Create/ })).not.toBeInTheDocument();
    // The token stays ordinary text; nothing was created or attached.
    expect(textarea).toHaveValue("existing status #pzzz");
  });

  it("closes on Escape without touching the draft", async () => {
    await mountTagged();
    const user = userEvent.setup();
    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, " #");
    expect(await screen.findByTestId("tag-menu")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("tag-menu")).not.toBeInTheDocument();
    expect(textarea).toHaveValue("existing status #");
  });

  it("follows its editor on document scroll without touching the tag token", async () => {
    await mountTagged();
    const user = userEvent.setup();
    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, " #");
    expect(await screen.findByTestId("tag-menu")).toBeVisible();

    const documentScroll = document.querySelector<HTMLElement>(".page-scroll");
    expect(documentScroll).not.toBeNull();
    fireEvent.scroll(documentScroll!);
    expect(screen.getByTestId("tag-menu")).toBeInTheDocument();
    expect(textarea).toHaveValue("existing status #");
    expect(textarea).toHaveFocus();
  });

  it("marks a tag the block already has and accepting it only removes the token", async () => {
    const { session } = await mountTagged();
    const user = userEvent.setup();
    await session.execute({
      type: "add_tag",
      entity: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
      tag_id: "project",
    });
    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, " #project");
    const menu = await screen.findByTestId("tag-menu");
    const option = within(menu).getByRole("option", { name: /Project/ });
    expect(option.querySelector(".tag-opt-check")).not.toBeNull();
    await user.keyboard("{Enter}");
    await waitFor(() => expect(textarea).toHaveValue("existing status"));
    const text = textarea.closest(".outline-text") as HTMLElement;
    expect(within(text).getAllByTestId("tag-chip")).toHaveLength(1);
  });
});

/** jsdom ships no `DataTransfer`; a drag only needs the three fields we touch. */
const transfer = () => ({ setData: () => {}, getData: () => "", dropEffect: "", effectAllowed: "" });

const rowNames = () =>
  screen.getAllByTestId("tag-row-link").map((link) => link.textContent);
const groupNames = () =>
  screen.getAllByTestId("tag-group-name").map((heading) => heading.textContent);

describe("the tags screen", () => {
  it("offers only the create action when the graph has no tags", async () => {
    await mountAt(`/g/${GRAPH_ID}/tags`);
    expect(await screen.findByTestId("new-tag")).toBeVisible();
    expect(screen.queryByTestId("tag-row")).not.toBeInTheDocument();
  });

  it("creates a tag, and keeps the field open for the next name", async () => {
    const { session } = await mountAt(`/g/${GRAPH_ID}/tags`);
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("new-tag"));
    const input = await screen.findByTestId("new-tag-name");
    await user.type(input, "Research{enter}");
    expect(await screen.findByTestId("tag-row")).toHaveTextContent("#Research");
    expect(screen.getByTestId("new-tag-name")).toHaveValue("");

    await act(async () => { await session.execute({ type: "undo" }); });
    await waitFor(() => expect(screen.queryByTestId("tag-row")).not.toBeInTheDocument());
  });

  it("refuses a duplicate name without creating anything", async () => {
    const { session } = await mountAt(`/g/${GRAPH_ID}/tags`);
    const user = userEvent.setup();
    await session.execute({ type: "ensure_tag", tag_id: "project", name: "Project" });
    await user.click(await screen.findByTestId("new-tag"));
    await user.type(screen.getByTestId("new-tag-name"), "  PROJECT {enter}");
    expect(await screen.findByText("Tag “PROJECT” already exists")).toBeVisible();
    expect(screen.getAllByTestId("tag-row")).toHaveLength(1);
  });

  it("says what each tag does and leads to it", async () => {
    const { session, router, settle } = await mountAt(`/g/${GRAPH_ID}/tags`);
    const user = userEvent.setup();
    await settle(async () => {
      await session.execute({ type: "ensure_tag", tag_id: "project", name: "Project" });
      await session.execute({
        type: "set_property",
        owner: { kind: "tag_default", tag_id: "project" },
        key: "builtin.task-priority",
        value: { type: "string", value: "high" },
      });
    });

    const row = await screen.findByTestId("tag-row");
    expect(row).toHaveTextContent("#Project");
    // The row names what the tag copies; the value belongs on the tag's own page,
    // where it has a column to sit in.
    expect(row).toHaveTextContent("Priority");
    expect(row).not.toHaveTextContent("High");

    await user.click(screen.getByTestId("tag-row-link"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/g/${GRAPH_ID}/t/project`),
    );
  });

  it("files a tag into a group, and renaming the group rewrites its members", async () => {
    const { session, settle } = await mountAt(`/g/${GRAPH_ID}/tags`);
    const user = userEvent.setup();
    await settle(async () => {
      await session.execute({ type: "ensure_tag", tag_id: "project", name: "Project" });
      await session.execute({ type: "ensure_tag", tag_id: "reading", name: "Reading" });
    });
    // One tag with no group at all: the only heading there could be says nothing.
    expect(screen.queryByTestId("tag-group-name")).not.toBeInTheDocument();

    await settle(async () => {
      for (const id of ["project", "reading"]) {
        await session.execute({
          type: "set_property",
          owner: { kind: "tag", tag_id: id },
          key: "builtin.tag-group",
          value: { type: "string", value: "Areas" },
        });
      }
    });
    await waitFor(() =>
      expect(screen.getByTestId("tag-group-name")).toHaveTextContent("Areas"),
    );

    await user.click(screen.getByTestId("tag-group-menu"));
    await user.click(await screen.findByTestId("tag-group-rename"));
    const field = await screen.findByTestId("tag-group-rename-field");
    await user.clear(field);
    await user.type(field, "Practices{enter}");
    await waitFor(() =>
      expect(screen.getByTestId("tag-group-name")).toHaveTextContent("Practices"),
    );
    // A group is a name its members carry; renaming it is rewriting them.
    expect(
      session.getState().snapshot.tags.map((tag) =>
        tag.properties.find((field) => field.key === "builtin.tag-group")?.values[0],
      ),
    ).toEqual([
      { type: "string", value: "Practices" },
      { type: "string", value: "Practices" },
    ]);

    await session.execute({ type: "undo" });
    await waitFor(() =>
      expect(screen.getByTestId("tag-group-name")).toHaveTextContent("Areas"),
    );
    expect(session.getState().snapshot.tags.map((tag) =>
      tag.properties.find((field) => field.key === "builtin.tag-group")?.values[0],
    )).toEqual([
      { type: "string", value: "Areas" },
      { type: "string", value: "Areas" },
    ]);
  });

  it("reorders tags inside a group, and says where the drop will land", async () => {
    const { session, settle } = await mountAt(`/g/${GRAPH_ID}/tags`);
    const user = userEvent.setup();
    await settle(async () => {
      for (const [id, name] of [["a", "Alpha"], ["b", "Bravo"], ["c", "Charlie"]]) {
        await session.execute({ type: "ensure_tag", tag_id: id, name });
        await session.execute({
          type: "set_property",
          owner: { kind: "tag", tag_id: id },
          key: "builtin.tag-group",
          value: { type: "string", value: "Areas" },
        });
      }
    });
    await waitFor(() => expect(screen.getAllByTestId("tag-row")).toHaveLength(3));
    expect(rowNames()).toEqual(["Alpha", "Bravo", "Charlie"]);

    // The menu is the keyboard's half of the drag, and it moves the same tag the
    // same distance.
    await user.click(screen.getAllByTestId("tag-row-menu")[0]);
    await user.click(await screen.findByTestId("tag-row-down"));
    await waitFor(() => expect(rowNames()).toEqual(["Bravo", "Alpha", "Charlie"]));

    // A drag says where it will land before it lands: one seam, on the row it is
    // about to sit beside, and nothing reflows until it is dropped.
    const rows = screen.getAllByTestId("tag-row");
    fireEvent.dragStart(rows[0], { dataTransfer: transfer() });
    fireEvent.dragOver(rows[2], { dataTransfer: transfer() });
    expect(rows[2]).toHaveAttribute("data-seam");
    expect(rowNames()).toEqual(["Bravo", "Alpha", "Charlie"]);
    fireEvent.drop(rows[2], { dataTransfer: transfer() });
    await waitFor(() => expect(rowNames()).toEqual(["Alpha", "Charlie", "Bravo"]));

    await act(async () => { await session.execute({ type: "undo" }); });
    await waitFor(() => expect(rowNames()).toEqual(["Bravo", "Alpha", "Charlie"]));
  });

  it("reorders groups among themselves", async () => {
    const { session, settle } = await mountAt(`/g/${GRAPH_ID}/tags`);
    const user = userEvent.setup();
    await settle(async () => {
      for (const [id, name, group] of [["a", "Alpha", "Areas"], ["b", "Bravo", "Home"]]) {
        await session.execute({ type: "ensure_tag", tag_id: id, name });
        await session.execute({
          type: "set_property",
          owner: { kind: "tag", tag_id: id },
          key: "builtin.tag-group",
          value: { type: "string", value: group },
        });
      }
    });
    await waitFor(() => expect(screen.getAllByTestId("tag-group-name")).toHaveLength(2));
    expect(groupNames()).toEqual(["Areas", "Home"]);

    await user.click(screen.getAllByTestId("tag-group-menu")[1]);
    await user.click(await screen.findByTestId("tag-group-up"));
    // A group has no record of its own, so its place is its members' places.
    await waitFor(() => expect(groupNames()).toEqual(["Home", "Areas"]));
  });

  it("customizes a tag's mark and colour from the one panel its mark opens", async () => {
    const { session } = await mountAt(`/g/${GRAPH_ID}/tags`);
    const user = userEvent.setup();
    await session.execute({ type: "ensure_tag", tag_id: "reading", name: "Reading" });
    await screen.findByTestId("tag-row");

    await user.click(screen.getByTestId("tag-mark"));
    const panel = await screen.findByTestId("tag-identity");
    await user.click(within(panel).getByTestId("tag-colour-teal"));
    await waitFor(() =>
      expect(screen.getByTestId("tag-mark")).toHaveAttribute("data-hue", "teal"),
    );

    await user.click(within(panel).getByRole("button", { name: "📚" }));
    await waitFor(() => expect(screen.getByTestId("tag-mark")).toHaveTextContent("📚"));

    // The group field in the same panel is the route that needs no pointer.
    const group = within(panel).getByTestId("tag-group-field");
    await user.type(group, "Areas");
    await user.tab();
    await waitFor(() =>
      expect(screen.getByTestId("tag-group-name")).toHaveTextContent("Areas"),
    );
  });
});

async function mountTagPage() {
  const harness = await mountAt(`/g/${GRAPH_ID}/t/project`);
  await harness.settle(async () => {
    await harness.session.execute({ type: "ensure_tag", tag_id: "project", name: "Project" });
    await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
    await harness.session.execute({
      type: "insert_block",
      owner: { kind: "page", id: "home" },
      parent: null,
      index: 0,
      markdown: "ship the thing",
    });
    await harness.session.execute({
      type: "add_tag",
      entity: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
      tag_id: "project",
    });
  });
  await screen.findByTestId("tag-title");
  return harness;
}

/** The tag document, or `undefined` while the page is still only a seed. */
function tagQuery(session: Awaited<ReturnType<typeof mountTagPage>>["session"]) {
  const tag = session.getState().snapshot.tags.find((item) => item.id === "project");
  const value = tag?.properties.find((field) => field.key === "builtin.query")?.values[0];
  return value?.type === "document" ? value.value : undefined;
}

describe("a tag's own page", () => {
  it("places its outline below the query view", async () => {
    await mountTagPage();

    const query = await screen.findByTestId("query-block");
    const outline = await screen.findByTestId("outline-start");
    expect(query.compareDocumentPosition(outline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("writes blocks into the tag's own outline", async () => {
    const { session } = await mountTagPage();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("outline-start"));
    const editor = await screen.findByLabelText("Block text");
    await user.type(editor, "Notes that belong to the tag");
    await user.tab();

    await waitFor(() => {
      const tag = session.getState().snapshot.tags.find((item) => item.id === "project");
      expect(tag?.blocks[0]?.markdown).toBe("Notes that belong to the tag");
    });
    expect(session.getState().snapshot.pages[0].blocks[0].markdown).toBe("ship the thing");
  });

  it("opens on the tag's own query without writing anything", async () => {
    const { session, port } = await mountTagPage();

    expect(screen.getByTestId("tag-title")).toHaveValue("Project");
    const block = await screen.findByTestId("query-block");
    expect(block).toHaveAttribute("data-variant", "page");
    // The seed asks the one question a tag is for, with the tag itself bound, and
    // the phrase for it names the control that opens it.
    expect(within(block).getByTestId("query-conditions-trigger"))
      .toHaveAttribute("title", expect.stringContaining("#Project"));
    const request = port.queryRequests.at(-1);
    expect(
      Object.values(request?.query.bindings ?? {}).map((term) => term.value),
    ).toContain(`urn:neoseq:entity:${GRAPH_ID}:tag:project`);
    // Reading a tag is a read: the seed becomes a document only when shaped.
    expect(tagQuery(session)).toBeUndefined();
  });

  it("keeps an empty default visible and materializes its empty field", async () => {
    const { session } = await mountTagPage();
    await session.execute({
      type: "ensure_property",
      owner: { kind: "tag_default", tag_id: "project" },
      key: "builtin.task-priority",
      value_type: "string",
      cardinality: "single",
    });

    expect(
      await screen.findByTestId("tag-default-builtin.task-priority"),
    ).toHaveTextContent("No value");

    await session.execute({
      type: "add_tag",
      entity: { kind: "block", owner: { kind: "page", id: "home" }, id: "b-1" },
      tag_id: "project",
    });
    const inherited = session.getState().snapshot.pages[0].blocks[0].properties
      .find((field) => field.key === "builtin.task-priority");
    expect(inherited?.values).toEqual([]);
  });

  it("edits its defaults through the same picker every other owner uses", async () => {
    const { session } = await mountTagPage();
    const user = userEvent.setup();
    await session.execute({
      type: "set_property",
      owner: { kind: "tag_default", tag_id: "project" },
      key: "builtin.task-priority",
      value: { type: "string", value: "high" },
    });
    expect(
      await screen.findByTestId("tag-default-builtin.task-priority"),
    ).toHaveTextContent("High");

    await user.click(screen.getByTestId("tag-add-default"));
    const picker = await screen.findByTestId("property-picker");
    await user.click(within(picker).getByRole("option", { name: "Status" }));
    await user.click(within(picker).getByRole("option", { name: "To-do" }));
    expect(
      await screen.findByTestId("tag-default-builtin.task-status"),
    ).toHaveTextContent("To-do");

    await user.click(screen.getByTestId("tag-default-builtin.task-priority"));
    const editor = await screen.findByTestId("property-picker");
    await user.click(within(editor).getByRole("button", { name: "Remove property" }));
    await waitFor(() =>
      expect(
        screen.queryByTestId("tag-default-builtin.task-priority"),
      ).not.toBeInTheDocument(),
    );
  });

  it("renames the tag from its own title", async () => {
    const { session } = await mountTagPage();
    const user = userEvent.setup();
    const title = screen.getByTestId("tag-title");
    await user.clear(title);
    await user.type(title, "Shipping{enter}");
    await waitFor(() =>
      expect(session.getState().snapshot.tags[0].name).toBe("Shipping"),
    );
  });

  it("deletes the tag from its own menu and leaves for the directory", async () => {
    const { session, router } = await mountTagPage();
    const user = userEvent.setup();
    const menu = await openTagMenu();
    await user.click(within(menu).getByTestId("tag-delete"));
    await user.click(await screen.findByTestId("confirm-delete-tag"));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/g/${GRAPH_ID}/tags`),
    );
    expect(session.getState().snapshot.tags).toHaveLength(0);
  });

  it("switches between the query's views from the tab strip", async () => {
    const { session } = await mountTagPage();
    const user = userEvent.setup();
    // One view, named for what it shows. A second is what a reader makes when
    // they mean a second question.
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["All"]);
    expect(tabs[0]).toHaveAttribute("aria-selected", "true");

    await user.click(await screen.findByTestId("query-view-add"));
    await user.click(await screen.findByRole("menuitem", { name: "List" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    // Adding one is what writes the tag's query for the first time.
    await waitFor(() => expect(tagQuery(session)?.views).toHaveLength(2));
    expect(screen.getAllByRole("tab")[1]).toHaveAttribute("aria-selected", "true");
  });

  // A tag page and a query in the outline ask the same question in the same
  // place: what a view *is* lives on the answer, and the tab's own menu is about
  // the tab. Before this, a page's tab held the layout rows and an outline's icon
  // held them, which put one choice in two places depending on where the query
  // was read.
  it("shapes the view from the answer and keeps the tab's menu about the tab", async () => {
    const { session } = await mountTagPage();
    const user = userEvent.setup();

    await chooseFromMenu(user, await screen.findByTestId("query-view-trigger"), "List");
    await waitFor(() => expect(tagQuery(session)?.views[0].kind).toBe("list"));

    const menu = await openViewMenu("All");
    expect(within(menu).getByTestId("query-view-rename")).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Duplicate view" })).toBeInTheDocument();
    expect(within(menu).queryByRole("menuitemradio", { name: "Table" })).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole("menuitemcheckbox", { name: "Compact rows" }),
    ).not.toBeInTheDocument();
  });

  it("renames the initial view without changing its identity", async () => {
    const { session } = await mountTagPage();
    const user = userEvent.setup();

    const menu = await openViewMenu("All");
    await user.click(within(menu).getByTestId("query-view-rename"));
    const field = await screen.findByTestId("query-view-rename-field");
    await user.clear(field);
    await user.type(field, "Everything{enter}");

    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "Everything" })).toBeVisible(),
    );
    expect(tagQuery(session)?.views[0]).toMatchObject({
      id: "all",
      name: "Everything",
    });
  });

  it("adds, renames, and deletes a view of its own", async () => {
    const { session } = await mountTagPage();
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("query-view-add"));
    await user.click(await screen.findByRole("menuitem", { name: "Table" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    // A new view opens on itself — adding one and not landing on it says nothing.
    const added = screen.getByRole("tab", { name: "Table" });
    expect(added).toHaveAttribute("aria-selected", "true");
    // …and the document it just brought into existence agrees with the screen.
    expect(tagQuery(session)?.default_view_id).not.toBe("all");

    const menu = await openViewMenu("Table");
    await user.click(within(menu).getByTestId("query-view-rename"));
    const field = await screen.findByTestId("query-view-rename-field");
    await user.clear(field);
    await user.type(field, "By status{enter}");
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: "By status" })).toBeVisible(),
    );
    expect(tagQuery(session)?.views).toHaveLength(2);

    const again = await openViewMenu("By status");
    await user.click(within(again).getByTestId("query-view-delete"));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(1));
    expect(tagQuery(session)?.views.map((view) => view.id)).toEqual(["all"]);
  });

  it("reorders its views by drag, and says where the tab will land", async () => {
    const { session } = await mountTagPage();
    const user = userEvent.setup();
    await user.click(await screen.findByTestId("query-view-add"));
    await user.click(await screen.findByRole("menuitem", { name: "List" }));
    await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
    const tabNames = () => screen.getAllByRole("tab").map((tab) => tab.textContent);
    expect(tabNames()).toEqual(["All", "List"]);

    const tabs = screen.getAllByRole("tab");
    fireEvent.dragStart(tabs[0], { dataTransfer: transfer() });
    fireEvent.dragOver(tabs[1], { dataTransfer: transfer() });
    // The seam says where it lands, and nothing moves until it is dropped.
    expect(tabs[1]).toHaveAttribute("data-seam", "after");
    expect(tabNames()).toEqual(["All", "List"]);
    fireEvent.drop(tabs[1], { dataTransfer: transfer() });
    await waitFor(() => expect(tabNames()).toEqual(["List", "All"]));
    // Positions, not an array order — so the document reads back in the order the
    // strip now shows, with the seeded view second.
    expect(tagQuery(session)?.views[1].id).toBe("all");

    await session.execute({ type: "undo" });
    await waitFor(() => expect(tabNames()).toEqual(["All", "List"]));
  });
});
