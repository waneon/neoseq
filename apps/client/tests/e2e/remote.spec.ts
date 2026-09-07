import { NeoseqApp } from "../support/app";
import { FIXED_TIME } from "../support/fixtures";
import {
  addRepository,
  createInSelectedRepository,
  createRemote,
  expect,
  expectSynced,
  graphId,
  openRemote,
  repositoryTab,
  test,
} from "../support/remote";

for (const persistent of [true, false]) {
  test(`${persistent ? "remembered" : "tab-scoped"} sign-in keeps the password out of storage and respects tab closure`, async ({
    app,
    remote,
  }) => {
    const page = app.page;
    await page.goto("/");
    await addRepository(page, remote.origin, remote.owner, persistent);
    await createInSelectedRepository(page, "Session notes");
    await app.startBlock("Saved before closing the tab");
    await expectSynced(page);
    const url = page.url();

    const passwordPersisted = await page.evaluate((password) => {
      return (
        JSON.stringify(localStorage).includes(password) ||
        JSON.stringify(sessionStorage).includes(password)
      );
    }, remote.owner.password);
    expect(passwordPersisted).toBe(false);
    expect(url.includes(remote.owner.password)).toBe(false);

    // A new page retains IndexedDB and localStorage while starting with empty
    // sessionStorage; no test code rewrites either store.
    await page.close();
    const reopened = await page.context().newPage();
    await reopened.clock.setFixedTime(new Date(FIXED_TIME));
    await reopened.goto(url);
    const reopenedApp = new NeoseqApp(reopened);
    await reopenedApp.expectOutline(["Saved before closing the tab"]);
    if (persistent) {
      await expectSynced(reopened);
      await reopenedApp.appendBlock("Shared after reopening");
      await expectSynced(reopened);
      const fresh = await remote.newProfile();
      await openRemote(fresh, remote, remote.owner, "Session notes");
      await fresh.expectOutline(["Saved before closing the tab", "Shared after reopening"]);
    } else {
      await expect(reopened.getByTestId("sync-status")).toHaveAttribute("data-sync", "paused");
      await reopened.goto("/");
      await repositoryTab(reopened, remote.origin, remote.owner).click();
      await expect(reopened.getByRole("button", { name: "Sign in", exact: true })).toBeVisible();
    }
    await reopened.close();
  });
}

test("a local archive imports into the remote repository as an independent, server-readable graph", async ({
  app,
  remote,
}) => {
  await app.createGraph("Portable notes");
  const originalId = graphId(app.page);
  await app.startBlock("Content carried by the archive");
  await app.appendBlock("A second portable block");
  await app.page.goto("/");
  await app.page.getByRole("button", { name: "Actions for Portable notes", exact: true }).click();
  const downloadPromise = app.page.waitForEvent("download");
  await app.page.getByTestId("export-graph-Portable notes").click();
  const archivePath = await (await downloadPromise).path();
  if (!archivePath) throw new Error("the graph archive download has no local path");

  await addRepository(app.page, remote.origin, remote.owner);
  const chooserPromise = app.page.waitForEvent("filechooser");
  await app.page.getByTestId("import-graph").click();
  await (await chooserPromise).setFiles(archivePath);
  await expect(app.page.getByTestId("journal-title")).toBeVisible();
  const importedId = graphId(app.page);
  expect(importedId).not.toBe(originalId);
  await app.expectOutline(["Content carried by the archive", "A second portable block"]);
  await expectSynced(app.page);
  await app.appendBlock("Added to the remote copy");
  await expectSynced(app.page);
  expect(await remote.catalog(remote.owner)).toMatchObject([
    { graph_id: importedId, display_name: "Portable notes", role: "owner" },
  ]);

  const fresh = await remote.newProfile();
  await openRemote(fresh, remote, remote.owner, "Portable notes");
  await fresh.expectOutline([
    "Content carried by the archive",
    "A second portable block",
    "Added to the remote copy",
  ]);

  await app.page.goto("/");
  await app.page.getByRole("tab", { name: "Local", exact: true }).click();
  await app.page.getByTestId("open-graph-Portable notes").click();
  expect(graphId(app.page)).toBe(originalId);
  await app.expectOutline(["Content carried by the archive", "A second portable block"]);
});

test("cancelling remote deletion preserves the graph and confirming removes it from the server", async ({
  app,
  remote,
}) => {
  await createRemote(app, remote, "Disposable notes");
  const id = graphId(app.page);
  await app.startBlock("Data requiring explicit deletion");
  await expectSynced(app.page);
  await app.page.goto("/");
  await repositoryTab(app.page, remote.origin, remote.owner).click();
  await app.page.getByRole("button", { name: "Actions for Disposable notes", exact: true }).click();
  await app.page.getByTestId("delete-server-graph-Disposable notes").click();
  await expect(app.page.getByRole("alertdialog")).toContainText("All members will lose access");
  await app.page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await remote.checkpointStatus(remote.owner, id)).toBe(200);
  await expect(app.page.getByTestId("open-graph-Disposable notes")).toBeVisible();

  await app.page.getByRole("button", { name: "Actions for Disposable notes", exact: true }).click();
  await app.page.getByTestId("delete-server-graph-Disposable notes").click();
  await app.page.getByTestId("confirm-delete-graph").click();
  await expect(app.page.getByTestId("open-graph-Disposable notes")).toHaveCount(0);
  expect(await remote.catalog(remote.owner)).toEqual([]);
  expect(await remote.checkpointStatus(remote.owner, id)).toBe(403);

  const fresh = await remote.newProfile();
  await fresh.page.goto("/");
  await addRepository(fresh.page, remote.origin, remote.owner);
  await expect(fresh.page.getByTestId("picker-empty")).toBeVisible();
});
