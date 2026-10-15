import { test, expect } from "../support/fixtures";

test("a second untitled page gets the next free name", async ({ app, page }) => {
  await app.createGraph("Untitled pages");
  for (const name of ["Untitled", "Untitled 2"]) {
    await app.sidebar();
    await app.saved(() => page.getByTestId("new-page").click());
    await expect(page.getByTestId("page-title")).toHaveValue(name);
  }
});
