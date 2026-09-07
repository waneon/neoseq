import { test, expect } from "../support/fixtures";

test("journal dates and graph identities keep independent durable content", async ({
  app,
  page,
}) => {
  await app.createGraph("Work");
  await expect(page.getByTestId("journal-calendar-trigger")).toHaveAttribute(
    "data-date",
    "2026-09-07",
  );
  await app.startBlock("Monday plan");
  const monday = page.url();
  await page.getByRole("button", { name: "Previous day" }).click();
  await expect(page.getByTestId("journal-calendar-trigger")).toHaveAttribute(
    "data-date",
    "2026-09-06",
  );
  await app.expectOutline([]);
  await app.startBlock("Sunday review");
  await page.getByRole("button", { name: "Today", exact: true }).click();
  await app.expectOutline(["Monday plan"]);

  await app.createGraph("Personal");
  await app.expectOutline([]);
  await app.startBlock("Personal note");
  const personal = page.url();
  expect(personal).not.toBe(monday);
  await page.goto(monday);
  await app.expectOutline(["Monday plan"]);
  await page.getByRole("button", { name: "Previous day" }).click();
  await app.expectOutline(["Sunday review"]);
  await page.goto(personal);
  await app.expectOutline(["Personal note"]);
});

test("duplicate page names are rejected without changing either page", async ({ app, page }) => {
  await app.createGraph("Naming");
  await app.createPage("Project Notes");
  await app.startBlock("Original content");
  const original = page.url();
  await app.createPage("Draft");
  await app.startBlock("Separate content");
  const draft = page.url();
  const title = page.getByTestId("page-title");
  await title.fill("  project   notes  ");
  await title.press("Enter");
  await expect(page.getByRole("alert")).toContainText("A page with that name already exists.");
  await expect(title).toHaveValue("Draft");
  await page.reload();
  await expect(title).toHaveValue("Draft");
  await app.expectOutline(["Separate content"]);
  await page.goto(original);
  await app.expectOutline(["Original content"]);
  await page.goto(draft);
  await app.saved(async () => {
    await title.fill("Meeting Notes");
    await title.press("Enter");
  });
  await page.reload();
  await expect(title).toHaveValue("Meeting Notes");
  await app.expectOutline(["Separate content"]);
});

test("graph deletion requires confirmation and preserves the other graph", async ({
  app,
  page,
}) => {
  await app.createGraph("Keep");
  await app.startBlock("Keep this note");
  await app.createGraph("Remove");
  await app.startBlock("Remove this note");
  await page.goto("/");
  await page.getByRole("button", { name: "Actions for Remove" }).click();
  await page.getByRole("menuitem", { name: "Rename graph" }).click();
  await page.getByTestId("rename-graph-name").fill("Discard");
  await page.getByTestId("rename-graph-submit").click();
  await expect(page.getByTestId("open-graph-Discard")).toBeVisible();
  await page.getByRole("button", { name: "Actions for Discard" }).click();
  await page.getByRole("menuitem", { name: /^Delete graph/ }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByTestId("open-graph-Discard")).toBeVisible();
  await page.getByRole("button", { name: "Actions for Discard" }).click();
  await page.getByRole("menuitem", { name: /^Delete graph/ }).click();
  await page.getByTestId("confirm-delete-graph").click();
  await expect(page.getByTestId("open-graph-Discard")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("open-graph-Keep")).toBeVisible();
  await expect(page.getByTestId("open-graph-Discard")).toHaveCount(0);
  await page.getByTestId("open-graph-Keep").click();
  await app.expectOutline(["Keep this note"]);
});
