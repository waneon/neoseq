// The generic property experience: five value types, unknown-key fallback,
// removal, validation errors, and defaults constraints — all through the
// same uniform editor.

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { GRAPH_ID, mountAt } from "./harness";

async function mountPage() {
  const harness = await mountAt(`/g/${GRAPH_ID}/p/home`);
  await harness.session.execute({ type: "ensure_page", page_id: "home", title: "Home" });
  await waitFor(() => expect(screen.getByTestId("page-title")).toHaveValue("Home"));
  return harness;
}

/**
 * Page properties are behind a disclosure now — the writing surface carries no
 * database chrome at rest — so the panel is opened the way a user opens it:
 * through the page ⋯ menu.
 */
async function openPageProperties(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByTestId("page-menu"));
  await user.click(await screen.findByTestId("menu-page-properties"));
  return screen.findByTestId("props-panel");
}

/** The tagged-block defaults live one level deeper, behind Advanced. */
async function openDefaults(user: ReturnType<typeof userEvent.setup>) {
  const panel = await openPageProperties(user);
  await user.click(within(panel).getByTestId("props-defaults-toggle"));
  return screen.findByTestId("props-defaults");
}

describe("generic property editor", () => {
  it("edits all five value types and keeps unknown keys editable", async () => {
    const { session } = await mountPage();
    const user = userEvent.setup();
    const entity = { kind: "page", id: "home" } as const;
    await session.execute({ type: "set_property", entity, key: "custom.text", value: { type: "string", value: "hello" } });
    await session.execute({ type: "set_property", entity, key: "custom.count", value: { type: "number", value: 4 } });
    await session.execute({ type: "set_property", entity, key: "custom.flag", value: { type: "checkbox", value: false } });
    await session.execute({ type: "set_property", entity, key: "custom.when", value: { type: "date", value: "2026-08-03" } });
    await session.execute({ type: "set_property", entity, key: "custom.link", value: { type: "page", value: "home" } });

    await openPageProperties(user);
    const section = await screen.findByTestId("props-page");
    // Unknown keys are flagged but rendered through the same rows.
    expect(within(section).getByTestId("prop-custom.text")).toHaveTextContent("custom");

    const text = within(section).getByLabelText("custom.text value");
    await user.clear(text);
    await user.type(text, "updated");
    await user.tab();
    await waitFor(() => expect(within(section).getByLabelText("custom.text value")).toHaveValue("updated"));

    const flag = within(section).getByLabelText("custom.flag value");
    await user.click(flag);
    await waitFor(() => expect(within(section).getByLabelText("custom.flag value")).toBeChecked());

    const count = within(section).getByLabelText("custom.count value");
    await user.clear(count);
    await user.type(count, "7{enter}");
    await waitFor(() => expect(within(section).getByLabelText("custom.count value")).toHaveValue(7));

    const when = within(section).getByLabelText("custom.when value");
    expect(when).toHaveValue("2026-08-03");

    // Page-typed values resolve their reference title.
    expect(within(section).getByTestId("prop-custom.link")).toHaveTextContent("Home");
  });

  it("adds and removes an unknown property through the add row", async () => {
    await mountPage();
    const user = userEvent.setup();
    await openPageProperties(user);
    const section = await screen.findByTestId("props-page");
    await user.type(within(section).getByLabelText("New property key"), "future.metric");
    await user.selectOptions(within(section).getByLabelText("New property type"), "number");
    await user.clear(within(section).getByLabelText("New property value"));
    await user.type(within(section).getByLabelText("New property value"), "42");
    await user.click(within(section).getByTestId("props-add-submit"));
    await waitFor(() => expect(within(section).getByTestId("prop-future.metric")).toBeInTheDocument());

    await user.click(within(section).getByTestId("remove-future.metric"));
    await waitFor(() =>
      expect(within(section).queryByTestId("prop-future.metric")).not.toBeInTheDocument(),
    );
  });

  it("surfaces validation errors for invalid defaults", async () => {
    await mountPage();
    const user = userEvent.setup();
    const section = await openDefaults(user);
    await user.type(within(section).getByLabelText("New property key"), "page.title");
    await user.type(within(section).getByLabelText("New property value"), "nope");
    await user.click(within(section).getByTestId("props-add-submit"));
    expect(await within(section).findByTestId("props-error")).toHaveTextContent(
      "cannot be a page default",
    );
  });

  it("edits well-known enum properties through allowed values", async () => {
    const { session } = await mountPage();
    const user = userEvent.setup();
    await session.execute({ type: "ensure_page", page_id: "task-page", title: "Task" });
    await session.execute({
      type: "insert_block",
      page_id: "home",
      parent: null,
      index: 0,
      markdown: "task",
    });
    await session.execute({
      type: "set_property",
      entity: { kind: "block", page_id: "home", id: "b-1" },
      key: "task.status",
      value: { type: "string", value: "todo" },
    });
    const menu = await screen.findByTestId("block-menu");
    await user.click(menu);
    await user.click(await screen.findByTestId("menu-properties"));
    const inspector = await screen.findByTestId("block-inspector");
    const select = within(inspector).getByLabelText("task.status value");
    await user.selectOptions(select, "doing");
    await waitFor(() =>
      expect(within(inspector).getByLabelText("task.status value")).toHaveValue("doing"),
    );
  });
});
