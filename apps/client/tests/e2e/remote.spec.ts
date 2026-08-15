import { expect, test } from "@playwright/test";
import { awaitSaved, startOutline, typeInFocusedBlock } from "./helpers";

test("remote graph creation keeps credentials out of URLs and remains local-first", async ({
  page,
  context,
}) => {
  await page.route("**/v1/graphs", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer test-browser-token");
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({ graph_id: "g-remote-browser" }),
    });
  });

  await page.goto("/");
  await page.getByTestId("new-graph-name").fill("Shared notes");
  await page.getByTestId("create-remote-graph").click();
  await page.getByLabel("Account ID").fill("browser-owner");
  await page.getByLabel("Access token").fill("test-browser-token");
  await page.getByRole("button", { name: "Create remote graph", exact: true }).last().click();

  await expect(page.getByTestId("journal-title")).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-save", "saved");
  expect(page.url()).not.toContain("test-browser-token");
  const storage = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
  }));
  expect(storage.local).not.toContain("test-browser-token");
  expect(storage.session).toContain("test-browser-token");

  await context.setOffline(true);
  await startOutline(page);
  await typeInFocusedBlock(page, "written while the sync server is unavailable");
  await awaitSaved(page);
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "pending");
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-live", "offline");

  await context.setOffline(false);
  await page.goto("/");
  const card = page.getByTestId("open-graph-Shared notes");
  await expect(card).toContainText("Remote");
});
