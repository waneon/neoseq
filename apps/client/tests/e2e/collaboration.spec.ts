import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { blockTexts, startOutline, typeInFocusedBlock } from "./helpers";

const syncOrigin = process.env.NEOSEQ_E2E_SYNC_ORIGIN;
const adminPassword = process.env.NEOSEQ_E2E_ADMIN_PASSWORD;
const ownerPassword = process.env.NEOSEQ_E2E_OWNER_PASSWORD;
const peerPassword = process.env.NEOSEQ_E2E_PEER_PASSWORD;

test.skip(
  !syncOrigin || !adminPassword || !ownerPassword || !peerPassword,
  "collaboration server credentials are not configured",
);

test.beforeAll(async ({ request }) => {
  await provisionAccounts(request);
});

test("two remote browser profiles converge after offline edits and revocation", async ({
  browser,
  page: peer,
}) => {
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const peerContext = peer.context();
  const graphName = `Collaboration ${Date.now()}`;

  await createRemote(owner, graphName, "e2e-owner", ownerPassword!);
  await invite(owner, "e2e-peer");
  await connectRemote(peer, graphName, "e2e-peer", peerPassword!);

  await startOutline(owner);
  await typeInFocusedBlock(owner, "owner online");
  await expect.poll(() => blockTexts(peer)).toContain("owner online");

  await peerContext.setOffline(true);
  await appendBlock(peer, "peer offline");
  await expect(peer.getByTestId("save-status")).toHaveAttribute("data-save", "saved");
  await expect(peer.getByTestId("live-status")).toHaveAttribute("data-live", "offline");

  await appendBlock(owner, "owner while peer offline");
  await peerContext.setOffline(false);
  await expect(peer.getByTestId("live-status")).toHaveAttribute("data-live", "live", {
    timeout: 30_000,
  });
  await expect(peer.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced", {
    timeout: 30_000,
  });
  await pollConverged(owner, peer);

  await revoke(owner, "e2e-peer");
  await expect(peer.getByTestId("sync-status")).toHaveAttribute("data-sync", "paused", {
    timeout: 15_000,
  });
  await appendBlock(peer, "still available locally");

  await ownerContext.close();
});

async function provisionAccounts(request: APIRequestContext) {
  const login = await request.post(`${syncOrigin}/v1/auth/login`, {
    data: { username: "e2e-admin", password: adminPassword, purpose: "admin" },
  });
  expect(login.ok()).toBe(true);
  const { access_token: token } = (await login.json()) as { access_token: string };
  for (const [username, password] of [
    ["e2e-owner", ownerPassword],
    ["e2e-peer", peerPassword],
  ]) {
    const response = await request.post(`${syncOrigin}/v1/admin/accounts`, {
      headers: { authorization: `Bearer ${token}` },
      data: { username, password, server_role: "user" },
    });
    expect([201, 409]).toContain(response.status());
  }
}

async function createRemote(page: Page, name: string, username: string, password: string) {
  await page.goto("/");
  await addRepository(page, username, password);
  await page.getByTestId("new-graph-name").fill(name);
  await page.getByTestId("create-graph").click();
  await expect(page.getByTestId("journal-title")).toBeVisible();
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-live", "live", {
    timeout: 15_000,
  });
}

async function connectRemote(page: Page, name: string, username: string, password: string) {
  await page.goto("/");
  await addRepository(page, username, password);
  await page.getByTestId(`open-graph-${name}`).click();
  await expect(page.getByTestId("journal-title")).toBeVisible();
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-live", "live", {
    timeout: 15_000,
  });
}

async function addRepository(page: Page, username: string, password: string) {
  await page.getByTestId("add-repository").click();
  await page.getByLabel("Server URL").fill(syncOrigin!);
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
}

async function invite(page: Page, principal: string) {
  await page.getByTestId("graph-switcher").click();
  await page.getByRole("menuitem", { name: "Manage members" }).click();
  // The invite field carries a visible label like its sibling fields; the
  // sign-in form above uses the same "Username" label, so scope to the row.
  await page.locator(".member-invite").getByLabel("Username").fill(principal);
  await page.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(page.locator(".member-list li", { hasText: principal })).toBeVisible();
  await page.getByRole("button", { name: "Close" }).click();
}

async function revoke(page: Page, principal: string) {
  await page.getByTestId("graph-switcher").click();
  await page.getByRole("menuitem", { name: "Manage members" }).click();
  const row = page.locator(".member-list li", { hasText: principal });
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(row).toHaveCount(0);
  await page.getByRole("button", { name: "Close" }).click();
}

async function appendBlock(page: Page, text: string) {
  const rows = page.locator('[data-testid="outline-row"] textarea');
  const last = rows.last();
  await last.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await typeInFocusedBlock(page, text);
}

async function pollConverged(owner: Page, peer: Page): Promise<string[]> {
  let latest: string[] = [];
  await expect
    .poll(
      async () => {
        const left = await blockTexts(owner);
        const right = await blockTexts(peer);
        latest = right;
        return JSON.stringify(left) === JSON.stringify(right);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  return latest;
}
