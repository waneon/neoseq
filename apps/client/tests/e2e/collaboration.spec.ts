import { expect, test, type Page } from "@playwright/test";
import { blockTexts, startOutline, typeInFocusedBlock } from "./helpers";

const ownerToken = process.env.NEOSEQ_E2E_OWNER_TOKEN;
const peerToken = process.env.NEOSEQ_E2E_PEER_TOKEN;

test.skip(!ownerToken || !peerToken, "collaboration server credentials are not configured");

test("two remote browser profiles converge after offline edits and revocation", async ({ browser, page: peer }) => {
  test.setTimeout(120_000);
  const ownerContext = await browser.newContext();
  const owner = await ownerContext.newPage();
  const peerContext = peer.context();
  const graphName = `Collaboration ${Date.now()}`;

  await createRemote(owner, graphName, "e2e-owner", ownerToken!);
  await invite(owner, "e2e-peer");
  await connectRemote(peer, graphName, "e2e-peer", peerToken!);

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

async function createRemote(page: Page, name: string, principal: string, token: string) {
  await page.goto("/");
  await page.getByTestId("new-graph-name").fill(name);
  await page.getByTestId("create-remote-graph").click();
  await page.getByLabel("Account ID").fill(principal);
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Create remote graph", exact: true }).last().click();
  await expect(page.getByTestId("journal-title")).toBeVisible();
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-live", "live", {
    timeout: 15_000,
  });
}

async function connectRemote(page: Page, name: string, principal: string, token: string) {
  await page.goto("/");
  await page.getByTestId("new-graph-name").fill(name);
  await page.getByTestId("create-remote-graph").click();
  await page.getByLabel("Account ID").fill(principal);
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Connect available graphs", exact: true }).click();
  await expect(page.getByTestId("journal-title")).toBeVisible();
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-live", "live", {
    timeout: 15_000,
  });
}

async function invite(page: Page, principal: string) {
  await page.getByTestId("graph-switcher").click();
  await page.getByRole("menuitem", { name: "Manage members" }).click();
  // The invite field carries a visible label like its sibling fields; the
  // sign-in form above uses the same "Account ID" label, so scope to the row.
  await page.locator(".member-invite").getByLabel("Account ID").fill(principal);
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
  await expect.poll(async () => {
    const left = await blockTexts(owner);
    const right = await blockTexts(peer);
    latest = right;
    return JSON.stringify(left) === JSON.stringify(right);
  }, { timeout: 30_000 }).toBe(true);
  return latest;
}
