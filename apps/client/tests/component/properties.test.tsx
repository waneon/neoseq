// Properties are visible inline and edited through one contextual picker.

import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { chooseFromMenu, GRAPH_ID, mountAt, openPageMenu } from "./harness";

async function mountPage() {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
  await waitFor(() => expect(screen.getByTestId("page-title")).toHaveValue("Home"));
  return harness;
}

async function openPagePicker(user: ReturnType<typeof userEvent.setup>) {
  await openPageMenu();
  await user.click(await screen.findByTestId("menu-page-properties"));
  return screen.findByTestId("property-picker");
}

/**
 * Drives the picker the way a user now does: a bare name (no `user.` prefix)
 * both searches and creates, and every surface shows the display name.
 */
async function createCustomProperty(
  user: ReturnType<typeof userEvent.setup>,
  name: string,
  type: "string" | "number" | "checkbox" | "date" | "page",
  value: string,
) {
  const picker = await openPagePicker(user);
  await user.type(within(picker).getByLabelText("Property key"), name);
  await user.click(within(picker).getByRole("option", { name: `Create property “${name}”` }));
  await user.click(within(picker).getByRole("option", { name: type }));
  if (type === "checkbox") {
    await user.click(within(picker).getByRole("option", { name: value === "yes" ? "Checked" : "Unchecked" }));
  } else {
    const input = within(picker).getByLabelText(`${name} value`);
    await user.clear(input);
    await user.type(input, value);
    await user.click(within(picker).getByTestId("property-set"));
  }
  await waitFor(() => expect(screen.queryByTestId("property-picker")).not.toBeInTheDocument());
}

describe("the page's own menu", () => {
  it("is named, even though its trigger is a coordinate rather than a control", async () => {
    await mountPage();
    const menu = await openPageMenu();
    expect(menu).toHaveAccessibleName("Page actions");
  });
});

describe("property picker", () => {
  it("edits all five value types and keeps unknown keys editable", async () => {
    const { session } = await mountPage();
    const user = userEvent.setup();
    const entity = { kind: "page", id: "home" } as const;
    await session.execute({ type: "set_property", entity, key: "user.text", value: { type: "string", value: "hello" } });
    await session.execute({ type: "set_property", entity, key: "user.count", value: { type: "number", value: 4 } });
    await session.execute({ type: "set_property", entity, key: "user.flag", value: { type: "checkbox", value: false } });
    await session.execute({ type: "set_property", entity, key: "user.when", value: { type: "date", value: "2026-08-03" } });
    await session.execute({ type: "set_property", entity, key: "user.link", value: { type: "page", value: "home" } });

    await user.click(await screen.findByTestId("prop-user.text"));
    let picker = await screen.findByTestId("property-picker");
    // Every surface speaks the display name: `user.text` reads as "text".
    const text = within(picker).getByLabelText("text value");
    await user.clear(text);
    await user.type(text, "updated{enter}");
    await waitFor(() => expect(screen.getByTestId("prop-user.text")).toHaveTextContent("updated"));

    await user.click(screen.getByTestId("prop-user.flag"));
    picker = await screen.findByTestId("property-picker");
    await user.click(within(picker).getByRole("option", { name: "Checked" }));
    await waitFor(() => expect(screen.getByTestId("prop-user.flag")).toHaveTextContent("yes"));

    await user.click(screen.getByTestId("prop-user.count"));
    picker = await screen.findByTestId("property-picker");
    const count = within(picker).getByLabelText("count value");
    await user.clear(count);
    await user.type(count, "7");
    await user.click(within(picker).getByTestId("property-set"));
    await waitFor(() => expect(screen.getByTestId("prop-user.count")).toHaveTextContent("7"));

    await user.click(screen.getByTestId("prop-user.when"));
    expect(within(await screen.findByTestId("property-picker")).getByLabelText("Pick a date"))
      .toHaveValue("2026-08-03");
    await user.keyboard("{Escape}");
    picker = await screen.findByTestId("property-picker");
    await user.click(within(picker).getByRole("option", { name: /link/ }));
    expect(within(picker).getByText("Home")).toBeInTheDocument();
  });

  it("creates and removes a custom property through the picker", async () => {
    await mountPage();
    const user = userEvent.setup();
    // A bare name is enough; storage adds the user. prefix on its own.
    await createCustomProperty(user, "metric", "number", "42");
    const row = await screen.findByTestId("prop-user.metric");
    expect(row).toHaveTextContent("42");

    await user.click(row);
    const picker = await screen.findByTestId("property-picker");
    await user.click(within(picker).getByRole("button", { name: "Clear property" }));
    await waitFor(() => expect(screen.queryByTestId("prop-user.metric")).not.toBeInTheDocument());
  });

  it("resolves a typed date phrase and commits it from the preview row", async () => {
    const { session } = await mountPage();
    const user = userEvent.setup();
    await session.execute({
      type: "set_property",
      entity: { kind: "page", id: "home" },
      key: "user.when",
      value: { type: "date", value: "2026-08-03" },
    });

    await user.click(await screen.findByTestId("prop-user.when"));
    const picker = await screen.findByTestId("property-picker");
    // An empty query offers the three most common answers.
    expect(within(picker).getByRole("option", { name: /Today/ })).toBeInTheDocument();
    expect(within(picker).getByRole("option", { name: /Tomorrow/ })).toBeInTheDocument();

    await user.type(within(picker).getByLabelText("Type a date"), "2026-12-24");
    await user.click(await within(picker).findByTestId("date-parsed"));
    await waitFor(() => expect(screen.getByTestId("prop-user.when")).toHaveTextContent("2026-12-24"));
  });

  it("surfaces validation errors for property keys that cannot exist", async () => {
    await mountPage();
    const user = userEvent.setup();
    const picker = await openPagePicker(user);
    // A dotted key is taken literally, so a malformed one is a dead end and
    // says so; a bare name would instead have become user.<name>.
    await user.type(within(picker).getByLabelText("Property key"), "user.Bad!");
    expect(await within(picker).findByTestId("props-error")).toHaveTextContent(
      "must use builtin.* or user.*",
    );
  });

  it("keeps core-managed properties outside the generic write path", async () => {
    const { session } = await mountPage();
    const user = userEvent.setup();
    const picker = await openPagePicker(user);
    await user.type(within(picker).getByLabelText("Property key"), "builtin.future-field");
    expect(await within(picker).findByTestId("props-error")).toHaveTextContent(
      "reserved and cannot be edited as a property",
    );

    await expect(session.execute({
      type: "set_property",
      entity: { kind: "page", id: "home" },
      key: "builtin.page-kind",
      value: { type: "string", value: "journal" },
    })).rejects.toThrow("managed by the core");
  });

  it("opens from slash and removes the slash token before applying a value", async () => {
    const { session } = await mountPage();
    const user = userEvent.setup();
    await session.execute({
      type: "insert_block",
      page_id: "home",
      parent: null,
      index: 0,
      markdown: "",
    });
    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, "/prop");
    expect(await screen.findByTestId("slash-menu")).toBeVisible();
    await user.keyboard("{Enter}");
    const picker = await screen.findByTestId("property-picker");
    expect(textarea).toHaveValue("");
    await user.click(within(picker).getByRole("option", { name: "Status" }));
    await user.click(within(picker).getByRole("option", { name: "Doing" }));
    await waitFor(() =>
      expect(screen.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: Doing"),
    );
  });

  it("sets a status straight from the slash menu, in one keystroke", async () => {
    const { session } = await mountPage();
    const user = userEvent.setup();
    await session.execute({
      type: "insert_block",
      page_id: "home",
      parent: null,
      index: 0,
      markdown: "ship it ",
    });
    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, "/done");
    const menu = await screen.findByTestId("slash-menu");
    expect(within(menu).getByRole("option", { name: /Done/ })).toBeVisible();
    await user.keyboard("{Enter}");
    // The token never reaches the Markdown — nor does the gap it sat behind —
    // and no picker opens for a direct item.
    await waitFor(() => expect(textarea).toHaveValue("ship it"));
    expect(screen.queryByTestId("property-picker")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: Done"),
    );
    // Settled text reads as settled.
    expect(textarea.closest(".outline-text")).toHaveAttribute("data-task-status", "done");
  });

  it("offers grouped commands for an empty slash query", async () => {
    const { session } = await mountPage();
    const user = userEvent.setup();
    await session.execute({
      type: "insert_block",
      page_id: "home",
      parent: null,
      index: 0,
      markdown: "",
    });
    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, "/");
    const menu = await screen.findByTestId("slash-menu");
    expect(within(menu).getByText("Task status")).toBeInTheDocument();
    expect(within(menu).getByText("Priority")).toBeInTheDocument();
    expect(within(menu).getByText("Date")).toBeInTheDocument();
    expect(within(menu).getByRole("option", { name: /Scheduled/ })).toBeInTheDocument();
    expect(within(menu).getByRole("option", { name: /Add property/ })).toBeInTheDocument();
    // Escape closes the menu without touching the draft.
    await user.keyboard("{Escape}");
    expect(screen.queryByTestId("slash-menu")).not.toBeInTheDocument();
    expect(textarea).toHaveValue("/");
  });

  it("closes the slash menu on a press anywhere past it", async () => {
    const { session } = await mountPage();
    const user = userEvent.setup();
    await session.execute({
      type: "insert_block",
      page_id: "home",
      parent: null,
      index: 0,
      markdown: "",
    });
    const textarea = await screen.findByLabelText("Block text");
    await user.click(textarea);
    await user.type(textarea, "/");
    expect(await screen.findByTestId("slash-menu")).toBeVisible();

    fireEvent.pointerDown(document.body, { button: 0 });
    await waitFor(() => expect(screen.queryByTestId("slash-menu")).not.toBeInTheDocument());
    expect(textarea).toHaveValue("/");
  });

  it("changes and removes a status from the inline control's own menu", async () => {
    const { session } = await mountPage();
    const user = userEvent.setup();
    await session.execute({ type: "insert_block", page_id: "home", parent: null, index: 0, markdown: "task" });
    await session.execute({
      type: "set_property",
      entity: { kind: "block", page_id: "home", id: "b-1" },
      key: "builtin.task-status",
      value: { type: "string", value: "todo" },
    });
    const toggle = await screen.findByTestId("task-status-toggle");
    await chooseFromMenu(user, toggle, "Doing");
    await waitFor(() =>
      expect(screen.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: Doing"),
    );

    // Removing the status is an explicit menu row, and it takes the control with it.
    await user.click(screen.getByTestId("task-status-toggle"));
    await user.click(await screen.findByTestId("remove-status"));
    await waitFor(() =>
      expect(screen.queryByTestId("task-status-toggle")).not.toBeInTheDocument(),
    );
  });
});
