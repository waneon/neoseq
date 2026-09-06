import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  chooseFromMenu,
  createGraph,
  insertQueryBlock,
  mutateAndAwaitSaved,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";

async function createQuery(page: Page): Promise<Locator> {
  await createGraph(page, "Query interaction");
  await startOutline(page);
  await typeInFocusedBlock(page, "A useful result");
  const content = page.getByLabel("Block text").first();
  await content.click();
  await content.press("End");
  await content.press("Enter");
  const query = page.getByTestId("query-block");
  await insertQueryBlock(
    page,
    page.getByLabel("Block text").last(),
    query.getByTestId("query-builder"),
  );
  return query;
}

/** Nested authoring and answer controls must remain reachable without panning. */
async function expectContainedControls(query: Locator): Promise<void> {
  const geometry = await query.evaluate((element) => {
    const boundary = element.getBoundingClientRect();
    const controls = [
      ...element.querySelectorAll<HTMLElement>(
        ".query-header, .query-header button, .query-toolbar, .query-toolbar button, " +
          ".qb-group, .qb-condition, .qb-summary-row, .query-builder input, .query-builder button",
      ),
    ].filter((node) => node.getClientRects().length > 0);
    return {
      left: boundary.left,
      right: boundary.right,
      viewport: document.documentElement.clientWidth,
      outside: controls.flatMap((node) => {
        const box = node.getBoundingClientRect();
        return box.left < boundary.left - 1 || box.right > boundary.right + 1
          ? [
              {
                control: node.getAttribute("aria-label") || node.textContent,
                left: box.left,
                right: box.right,
              },
            ]
          : [];
      }),
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(-1);
  expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.outside).toEqual([]);
}

test("query controls name the question and recover an empty answer", async ({ page }) => {
  const query = await createQuery(page);
  const conditions = query.getByRole("button", { name: "Conditions", exact: true });
  await expect(query.locator(".query-heading .query-title")).toHaveText("Blocks");
  await expect(conditions).toContainText("Conditions");
  await expect(query.getByRole("button", { name: "Columns", exact: true })).toContainText(
    "Columns",
  );
  await expect(query.getByRole("button", { name: "Sort order", exact: true })).toContainText(
    "Sort",
  );
  await expect(
    query.getByRole("button", { name: "Result layout: Table", exact: true }),
  ).toContainText("Table");
  await expectContainedControls(query);

  await mutateAndAwaitSaved(page, () => query.getByTestId("qb-add-condition").click());
  const condition = query.getByTestId("qb-condition");
  await expect(condition.getByRole("combobox", { name: "Field", exact: true })).toContainText(
    "Text",
  );
  await expect(condition.getByRole("textbox", { name: "Value", exact: true })).toBeVisible();
  const missing = "a phrase that no block contains";
  await mutateAndAwaitSaved(page, () =>
    condition.getByRole("textbox", { name: "Value", exact: true }).fill(missing),
  );
  await conditions.focus();
  await conditions.press("Enter");
  await expect(conditions).toHaveAttribute("aria-expanded", "false");
  await expect(query.getByTestId("query-builder")).toHaveCount(0);
  await expect(query.locator(".query-summary")).toContainText(missing);

  const empty = query.getByTestId("query-empty");
  await expect(empty).toContainText("No matches. Adjust the conditions or add matching content.");
  const recover = empty.getByRole("button", { name: "Edit conditions", exact: true });
  await recover.focus();
  await recover.press("Space");
  await expect(query.getByTestId("qb-subject")).toBeFocused();
  await expect(conditions).toHaveAttribute("aria-expanded", "true");
  await expect(condition.getByRole("textbox", { name: "Value", exact: true })).toHaveValue(missing);
  await mutateAndAwaitSaved(page, () =>
    condition.getByRole("textbox", { name: "Value", exact: true }).fill("useful"),
  );
  await expect(query.getByTestId("query-table")).toContainText("A useful result");
  await expect(empty).toHaveCount(0);
});

test("nested filters keep typed values and controls within the query", async ({ page }) => {
  const query = await createQuery(page);
  await mutateAndAwaitSaved(page, () => query.getByTestId("qb-add-condition").click());
  const text = query.getByTestId("qb-condition").first();
  await mutateAndAwaitSaved(page, () =>
    text
      .getByRole("textbox", { name: "Value", exact: true })
      .fill("A long filter value that remains editable on a narrow screen"),
  );
  await mutateAndAwaitSaved(page, () => query.getByTestId("qb-add-group").click());
  const nested = query.locator('.qb-group[data-depth="1"]');
  await mutateAndAwaitSaved(page, () =>
    nested.getByRole("button", { name: "Add group", exact: true }).click(),
  );
  const inner = query.locator('.qb-group[data-depth="2"]');
  await mutateAndAwaitSaved(page, () =>
    inner.getByRole("button", { name: "Add condition", exact: true }).click(),
  );
  const typed = inner.getByTestId("qb-condition");
  await mutateAndAwaitSaved(page, () =>
    chooseFromMenu(page, typed.getByRole("combobox", { name: "Field", exact: true }), "Deadline"),
  );
  await expect(typed.getByRole("combobox", { name: "Date", exact: true })).toBeVisible();
  await chooseFromMenu(
    page,
    typed.getByRole("combobox", { name: "Date", exact: true }),
    "Exact date…",
  );
  const date = typed.getByLabel("Exact date", { exact: true });
  await expect(date).toHaveAttribute("type", "date");
  await mutateAndAwaitSaved(page, () => date.fill("2026-09-07"));
  await expect(date).toHaveValue("2026-09-07");
  await expectContainedControls(query);

  await mutateAndAwaitSaved(page, () =>
    chooseFromMenu(page, typed.getByRole("combobox", { name: "Field", exact: true }), "Status"),
  );
  await expect(typed.getByRole("combobox", { name: "Value", exact: true })).toBeVisible();
  await mutateAndAwaitSaved(page, () =>
    chooseFromMenu(page, typed.getByRole("combobox", { name: "Value", exact: true }), "Doing"),
  );
  await expect(typed.getByRole("combobox", { name: "Value", exact: true })).toContainText("Doing");
  await expectContainedControls(query);

  await mutateAndAwaitSaved(page, () =>
    chooseFromMenu(page, query.getByTestId("qb-grain"), "Summary"),
  );
  await expect(query.getByTestId("qb-summary-fields")).toBeVisible();
  await expectContainedControls(query);
});

test("conditions disclosure survives reload without browser preferences", async ({ page }) => {
  const query = await createQuery(page);
  const toggle = query.getByTestId("query-conditions-trigger");
  await mutateAndAwaitSaved(page, () => toggle.click());
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(query.getByTestId("query-builder")).toHaveCount(0);

  await mutateAndAwaitSaved(page, () => toggle.click());
  await mutateAndAwaitSaved(page, () => query.getByTestId("qb-add-condition").click());
  await mutateAndAwaitSaved(page, () => query.getByTestId("qb-value").fill("useful"));
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(query.getByTestId("qb-value")).toHaveValue("useful");
  await expect(query.getByTestId("query-table")).toContainText("A useful result");
});
