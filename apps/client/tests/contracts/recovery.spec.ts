import { test, expect } from "../support/fixtures";
import type {} from "../../src/features/shell/GraphShell";

for (const fault of ["abort", "quota"] as const) {
  test(`${fault}: failed append retains the exact edit until retry makes it durable`, async ({
    app,
    page,
  }) => {
    await app.createGraph("Storage recovery");
    await app.startBlock("Durable baseline");
    await page.evaluate((kind) => window.__neoseqTest!.injectStorageFault(kind), fault);
    await app.editors.first().fill("Pending edit must not disappear");
    await app.editors.first().blur();
    const status = page.getByTestId("save-status");
    await expect(status).toHaveAttribute("data-save", "unsaved");
    await expect(status).toHaveAttribute(
      "data-save-code",
      fault === "quota" ? "storage_full" : "dirty_unsaved",
    );
    await app.expectOutline(["Pending edit must not disappear"]);
    await expect(page.getByTestId("retry-save")).toBeVisible();
    await page.getByTestId("retry-save").click();
    await expect(status).toHaveAttribute("data-save", "saved");
    await page.reload();
    await app.expectOutline(["Pending edit must not disappear"]);
    await app.appendBlock("Writing works after recovery");
    await page.reload();
    await app.expectOutline(["Pending edit must not disappear", "Writing works after recovery"]);
  });
}
