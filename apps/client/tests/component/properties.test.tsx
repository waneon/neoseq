// Properties are visible inline and edited through one contextual picker.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { GRAPH_ID, mountAt, openPageMenu } from "./harness";

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

async function createCustomProperty(
  user: ReturnType<typeof userEvent.setup>,
  key: string,
  type: "string" | "number" | "checkbox" | "date" | "page",
  value: string,
) {
  const picker = await openPagePicker(user);
  await user.type(within(picker).getByLabelText("Property key"), key);
  await user.click(within(picker).getByRole("option", { name: `Create property “${key}”` }));
  await user.click(within(picker).getByRole("option", { name: type }));
  if (type === "checkbox") {
    await user.click(within(picker).getByRole("option", { name: value === "yes" ? "Checked" : "Unchecked" }));
  } else {
    const input = within(picker).getByLabelText(`${key} value`);
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
    await session.execute({ type: "set_property", entity, key: "custom.text", value: { type: "string", value: "hello" } });
    await session.execute({ type: "set_property", entity, key: "custom.count", value: { type: "number", value: 4 } });
    await session.execute({ type: "set_property", entity, key: "custom.flag", value: { type: "checkbox", value: false } });
    await session.execute({ type: "set_property", entity, key: "custom.when", value: { type: "date", value: "2026-08-03" } });
    await session.execute({ type: "set_property", entity, key: "custom.link", value: { type: "page", value: "home" } });

    await user.click(await screen.findByTestId("prop-custom.text"));
    let picker = await screen.findByTestId("property-picker");
    const text = within(picker).getByLabelText("custom.text value");
    await user.clear(text);
    await user.type(text, "updated{enter}");
    await waitFor(() => expect(screen.getByTestId("prop-custom.text")).toHaveTextContent("updated"));

    await user.click(screen.getByTestId("prop-custom.flag"));
    picker = await screen.findByTestId("property-picker");
    await user.click(within(picker).getByRole("option", { name: "Checked" }));
    await waitFor(() => expect(screen.getByTestId("prop-custom.flag")).toHaveTextContent("yes"));

    await user.click(screen.getByTestId("prop-custom.count"));
    picker = await screen.findByTestId("property-picker");
    const count = within(picker).getByLabelText("custom.count value");
    await user.clear(count);
    await user.type(count, "7");
    await user.click(within(picker).getByTestId("property-set"));
    await waitFor(() => expect(screen.getByTestId("prop-custom.count")).toHaveTextContent("7"));

    await user.click(screen.getByTestId("prop-custom.when"));
    expect(within(await screen.findByTestId("property-picker")).getByLabelText("custom.when value"))
      .toHaveValue("2026-08-03");
    await user.keyboard("{Escape}");
    picker = await screen.findByTestId("property-picker");
    await user.click(within(picker).getByRole("option", { name: /custom\.link/ }));
    expect(within(picker).getByText("Home")).toBeInTheDocument();
  });

  it("creates and removes a custom property through the picker", async () => {
    await mountPage();
    const user = userEvent.setup();
    await createCustomProperty(user, "future.metric", "number", "42");
    const row = await screen.findByTestId("prop-future.metric");
    expect(row).toHaveTextContent("42");

    await user.click(row);
    const picker = await screen.findByTestId("property-picker");
    await user.click(within(picker).getByRole("button", { name: "Clear property" }));
    await waitFor(() => expect(screen.queryByTestId("prop-future.metric")).not.toBeInTheDocument());
  });

  it("surfaces validation errors for structural property keys", async () => {
    await mountPage();
    const user = userEvent.setup();
    const picker = await openPagePicker(user);
    await user.type(within(picker).getByLabelText("Property key"), "page.title");
    expect(await within(picker).findByTestId("props-error")).toHaveTextContent(
      "reserved and cannot be edited as a property",
    );
  });

  it("keeps core-managed properties outside the generic write path", async () => {
    const { session } = await mountPage();
    const user = userEvent.setup();
    const picker = await openPagePicker(user);
    await user.type(within(picker).getByLabelText("Property key"), "system.deleted-at");
    expect(await within(picker).findByTestId("props-error")).toHaveTextContent(
      "reserved and cannot be edited as a property",
    );

    await expect(session.execute({
      type: "set_property",
      entity: { kind: "page", id: "home" },
      key: "page.kind",
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
    await user.type(textarea, "/pro");
    expect(await screen.findByTestId("slash-menu")).toBeVisible();
    await user.keyboard("{Enter}");
    const picker = await screen.findByTestId("property-picker");
    expect(textarea).toHaveValue("");
    await user.click(within(picker).getByRole("option", { name: "task.status" }));
    await user.click(within(picker).getByRole("option", { name: "doing" }));
    await waitFor(() => expect(screen.getByTestId("prop-task.status")).toHaveTextContent("doing"));
  });

  it("edits a well-known enum directly from its inline row", async () => {
    const { session } = await mountPage();
    const user = userEvent.setup();
    await session.execute({ type: "insert_block", page_id: "home", parent: null, index: 0, markdown: "task" });
    await session.execute({
      type: "set_property",
      entity: { kind: "block", page_id: "home", id: "b-1" },
      key: "task.status",
      value: { type: "string", value: "todo" },
    });
    await user.click(await screen.findByTestId("prop-task.status"));
    const picker = await screen.findByTestId("property-picker");
    await user.click(within(picker).getByRole("option", { name: "doing" }));
    await waitFor(() => expect(screen.getByTestId("prop-task.status")).toHaveTextContent("doing"));

  });
});
