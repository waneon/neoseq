import { test, expect } from "../support/fixtures";

test("a long graph name stays inside the library column", async ({ app, page }) => {
  const name = "A graph whose name keeps going ".repeat(6).trim();
  await app.createGraph(name);
  await page.goto("/");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    const actions = page.getByRole("button", { name: `Actions for ${name}`, exact: true });
    const panel = page.getByRole("tabpanel");
    const [button, column] = await Promise.all([actions.boundingBox(), panel.boundingBox()]);
    expect(button!.x + button!.width, `${width}px`).toBeLessThanOrEqual(column!.x + column!.width);
    expect(column!.x + column!.width, `${width}px`).toBeLessThanOrEqual(width);
  }
});

test("Tab moves from New graph to the first graph", async ({ app, page }) => {
  await app.createGraph("Only graph");
  await page.goto("/");
  await page.getByTestId("new-graph").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tabpanel").getByRole("button").first()).toBeFocused();
});
