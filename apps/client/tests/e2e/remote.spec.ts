import { expect, test, type Page } from "@playwright/test";
import { startOutline, typeInFocusedBlock } from "./helpers";

interface CreatedGraph {
  graph_id: string;
  name: string;
}

test("a remote repository keeps its opaque session without persisting the password", async ({
  page,
  context,
}) => {
  const created = await installRemoteApi(page);

  await page.goto("/");
  await addRemoteRepository(page);
  await expect(page.getByRole("tab", { name: /browser-owner@/u })).toHaveAttribute(
    "data-state",
    "active",
  );

  await page.getByTestId("new-graph-name").fill("Shared notes");
  await page.getByTestId("create-graph").click();

  await expect(page.getByTestId("journal-title")).toBeVisible();
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-save", "saved");
  expect(page.url()).toMatch(/\/r\/[^/]+\/g\/g-/u);
  const remoteGraphId = graphId(page.url());
  await markMockServerBase(page);
  await page.reload();
  await expect(page.getByTestId("journal-title")).toBeVisible();
  expect(page.url()).not.toContain("test-browser-token");
  const storage = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
  }));
  expect(storage.local).toContain("test-browser-token");
  expect(storage.local).not.toContain("correct horse battery staple");
  expect(storage.session).not.toContain("test-browser-token");
  expect(storage.session).not.toContain("correct horse battery staple");

  // Closing a browser discards sessionStorage. The remembered opaque session
  // remains sufficient to reopen the repository without retaining a password.
  await page.evaluate(() => sessionStorage.clear());
  await page.reload();
  await expect(page.getByTestId("journal-title")).toBeVisible();

  await context.setOffline(true);
  await startOutline(page);
  await typeInFocusedBlock(page, "written while the sync server is unavailable");
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "pending");
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-live", "offline");

  await context.setOffline(false);
  await page.goto("/");
  await page.getByRole("tab", { name: /browser-owner@/u }).click();
  await expect(page.getByTestId("open-graph-Shared notes")).toContainText("Owner");
  expect(created).toEqual([{ graph_id: remoteGraphId, name: "Shared notes" }]);
});

test("imports an archive as a new graph in the selected remote repository", async ({ page }) => {
  const created = await installRemoteApi(page);

  await page.goto("/");
  await page.getByTestId("new-graph-name").fill("Archive source");
  await page.getByTestId("create-graph").click();
  await startOutline(page);
  await typeInFocusedBlock(page, "portable remote note");

  await page.goto("/");
  await page.getByRole("button", { name: "Actions for Archive source" }).click();
  const downloadStarted = page.waitForEvent("download");
  await page.getByTestId("export-graph-Archive source").click();
  const archivePath = await (await downloadStarted).path();
  if (!archivePath) throw new Error("the graph archive download has no local path");

  await addRemoteRepository(page);
  const chooseArchive = page.waitForEvent("filechooser");
  await page.getByTestId("import-graph").click();
  await (await chooseArchive).setFiles(archivePath);

  await expect(page.getByTestId("journal-title")).toBeVisible();
  await expect(page.getByText("portable remote note")).toBeVisible();
  const importedId = graphId(page.url());
  expect(created).toEqual([{ graph_id: importedId, name: "Archive source" }]);
  expect(page.url()).toMatch(/\/r\/[^/]+\/g\//u);
});

test("can keep a remote session scoped to the current browser tab", async ({ page }) => {
  await installRemoteApi(page, false);

  await page.goto("/");
  await addRemoteRepository(page, false);
  await expect(page.getByRole("tab", { name: /browser-owner@/u })).toHaveAttribute(
    "data-state",
    "active",
  );
  const storage = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
  }));
  expect(storage.local).not.toContain("test-browser-token");
  expect(storage.session).toContain("test-browser-token");
});

test("repository tabs retain cached catalogs while revalidating without moving the picker", async ({
  page,
}) => {
  const remoteGraph = {
    graph_id: "g-stable-remote",
    display_name: "Stable remote",
    created_at: "2026-08-30T00:00:00Z",
    updated_at: "2026-08-30T00:00:00Z",
    role: "owner",
    status: "active",
    membership_version: 1,
  };
  let holdRefresh = false;
  let refreshStarted = false;
  let releaseRefresh: (() => void) | undefined;

  await page.route("**/v1/auth/login", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "test-browser-token",
        expires_at: 4_102_444_800,
        account: { account_id: "account-browser-owner", username: "browser-owner" },
      }),
    });
  });
  await page.route("**/v1/graphs", async (route) => {
    if (holdRefresh) {
      refreshStarted = true;
      await new Promise<void>((resolve) => {
        releaseRefresh = resolve;
      });
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ graphs: [remoteGraph] }),
    });
  });

  await page.goto("/");
  await addRemoteRepository(page);
  await expect(page.getByTestId("open-graph-Stable remote")).toBeVisible();

  const picker = page.locator(".picker-inner");
  const localTab = page.getByRole("tab", { name: "Local", exact: true });
  const remoteTab = page.getByRole("tab", { name: /browser-owner@/u });
  await localTab.click();
  await expect(page.getByTestId("picker-empty")).toBeVisible();
  const localTop = (await picker.boundingBox())?.y;
  expect(localTop).toBeDefined();

  holdRefresh = true;
  await remoteTab.click();
  await expect.poll(() => refreshStarted).toBe(true);
  await expect(page.getByTestId("open-graph-Stable remote")).toBeVisible();
  await expect(page.getByTestId("graph-list-loading")).toHaveCount(0);
  expect((await picker.boundingBox())?.y).toBeCloseTo(localTop!, 1);

  await localTab.click();
  await expect(page.getByTestId("picker-empty")).toBeVisible();
  releaseRefresh?.();
  await expect(remoteTab).toHaveAttribute("data-state", "inactive");
  await expect(page.getByTestId("open-graph-Stable remote")).toHaveCount(0);
  expect((await picker.boundingBox())?.y).toBeCloseTo(localTop!, 1);
});

async function installRemoteApi(page: Page, expectedPersistent = true): Promise<CreatedGraph[]> {
  const created: CreatedGraph[] = [];
  await page.route("**/v1/auth/login", async (route) => {
    const credentials = route.request().postDataJSON() as {
      username: string;
      password: string;
    };
    expect(credentials).toMatchObject({
      username: "browser-owner",
      password: "correct horse battery staple",
      purpose: "client",
      persistent: expectedPersistent,
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        access_token: "test-browser-token",
        expires_at: 4_102_444_800,
        account: { account_id: "account-browser-owner", username: "browser-owner" },
      }),
    });
  });
  await page.route("**/v1/auth/me", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer test-browser-token");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        account_id: "account-browser-owner",
        username: "browser-owner",
        server_role: "user",
        purpose: "client",
      }),
    });
  });
  await page.route("**/v1/graphs/import", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer test-browser-token");
    const body = route.request().postDataBuffer();
    if (!body) throw new Error("seeded graph request omitted its multipart body");
    const graphId = multipartField(body, "graph_id");
    const name = multipartField(body, "name");
    const checkpointChecksum = multipartField(body, "checkpoint_checksum");
    created.push({ graph_id: graphId, name });
    await route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        graph_id: graphId,
        history_epoch: 0,
        checkpoint_checksum: checkpointChecksum,
      }),
    });
  });
  await page.route("**/v1/graphs", async (route) => {
    expect(route.request().headers().authorization).toBe("Bearer test-browser-token");
    if (route.request().method() === "POST") {
      const request = route.request().postDataJSON() as { graph_id: string; name: string };
      const graphId = request.graph_id;
      created.push({ graph_id: graphId, name: request.name });
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({
          graph_id: graphId,
          history_epoch: 0,
          checkpoint_checksum: "mock-empty-checkpoint",
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        graphs: created.map((graph) => ({
          graph_id: graph.graph_id,
          display_name: graph.name,
          created_at: "2026-08-30T00:00:00Z",
          updated_at: "2026-08-30T00:00:00Z",
          role: "owner",
          status: "active",
          membership_version: 1,
        })),
      }),
    });
  });
  return created;
}

function multipartField(body: Buffer, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = body
    .toString("latin1")
    .match(new RegExp(`name="${escaped}"\\r\\n\\r\\n([^\\r\\n]*)`, "u"));
  if (!match) throw new Error(`multipart field ${name} is missing`);
  return match[1];
}

async function markMockServerBase(page: Page): Promise<void> {
  const parsed = new URL(page.url());
  const route = parsed.hash.startsWith("#/") ? parsed.hash.slice(1) : parsed.pathname;
  const match = route.match(/\/r\/([^/]+)\/g\/([^/]+)/u);
  if (!match) throw new Error(`expected a remote graph route, received ${page.url()}`);
  const storageKey = `repository:${JSON.stringify([
    decodeURIComponent(match[1]),
    decodeURIComponent(match[2]),
  ])}`;
  await page.evaluate(
    ({ key }) =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("neoseq-local-v1", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("sync-state", "readwrite");
          transaction.objectStore("sync-state").put({ graph_id: key, server_base: true });
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => reject(transaction.error);
        };
      }),
    { key: storageKey },
  );
}

async function addRemoteRepository(page: Page, persistent = true): Promise<void> {
  const serverOrigin = new URL(page.url()).origin;
  await page.getByTestId("add-repository").click();
  await page.getByLabel("Server URL").fill(serverOrigin);
  await page.getByLabel("Username").fill("browser-owner");
  await page.getByLabel("Password").fill("correct horse battery staple");
  if (!persistent) await page.getByLabel("Keep me signed in on this browser").uncheck();
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

function graphId(url: string): string {
  const parsed = new URL(url);
  const route = parsed.hash.startsWith("#/") ? parsed.hash.slice(1) : parsed.pathname;
  const match = route.match(/\/g\/([^/]+)/u);
  if (!match) throw new Error(`expected a graph route, received ${url}`);
  return decodeURIComponent(match[1]);
}
