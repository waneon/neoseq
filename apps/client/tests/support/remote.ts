import { randomUUID } from "node:crypto";
import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { NeoseqApp } from "./app";
import { expect, FIXED_TIME, test as base } from "./fixtures";

export { expect };

export interface RemoteAccount {
  accountId: string;
  username: string;
  password: string;
  token: string;
}

interface RemoteGraph {
  graph_id: string;
  display_name: string;
  role: "owner" | "editor" | "viewer";
}

interface RemoteServer {
  origin: string;
  /** Accepted updates after which the server compacts a graph's checkpoint. */
  checkpointTailUpdates: number;
  owner: RemoteAccount;
  peer: RemoteAccount;
  newProfile(): Promise<NeoseqApp>;
  catalog(account: RemoteAccount): Promise<RemoteGraph[]>;
  checkpointStatus(account: RemoteAccount, graphId: string): Promise<number>;
}

/** Every test owns its server identities, graph catalog, and browser profiles. */
export const test = base.extend<{ remote: RemoteServer }>({
  remote: async ({ request, browser, baseURL, locale, timezoneId, viewport, colorScheme }, use) => {
    const origin = requiredEnvironment("NEOSEQ_E2E_SYNC_ORIGIN");
    const adminPassword = requiredEnvironment("NEOSEQ_E2E_ADMIN_PASSWORD");
    const checkpointTailUpdates = Number(requiredEnvironment("NEOSEQ_E2E_CHECKPOINT_TAIL_UPDATES"));
    const admin = await login(request, origin, "e2e-admin", adminPassword, "admin");
    const adminHeaders = { authorization: `Bearer ${admin}` };
    const accounts: RemoteAccount[] = [];
    const contexts: BrowserContext[] = [];
    const browserErrors: string[] = [];

    const catalog = async (account: RemoteAccount): Promise<RemoteGraph[]> => {
      const response = await request.get(`${origin}/v1/graphs`, {
        headers: { authorization: `Bearer ${account.token}` },
      });
      expect(response.status(), "read the authenticated server catalog").toBe(200);
      return ((await response.json()) as { graphs: RemoteGraph[] }).graphs;
    };

    const provision = async (label: string): Promise<RemoteAccount> => {
      const username = `e2e-${label}-${randomUUID()}`;
      const password = randomUUID();
      const response = await request.post(`${origin}/v1/admin/accounts`, {
        headers: adminHeaders,
        data: { username, password, server_role: "user" },
      });
      expect(response.status(), `create isolated ${label} account`).toBe(201);
      const { account_id: accountId } = (await response.json()) as { account_id: string };
      const account = { accountId, username, password, token: "" };
      accounts.push(account);
      account.token = await login(request, origin, username, password, "client");
      return account;
    };

    try {
      const owner = await provision("owner");
      const peer = await provision("peer");
      await use({
        origin,
        checkpointTailUpdates,
        owner,
        peer,
        catalog,
        checkpointStatus: async (account, graphId) => {
          const response = await request.get(`${origin}/v1/graphs/${graphId}/checkpoint`, {
            headers: { authorization: `Bearer ${account.token}` },
          });
          return response.status();
        },
        newProfile: async () => {
          const context = await browser.newContext({
            baseURL,
            locale,
            timezoneId,
            viewport,
            colorScheme,
          });
          contexts.push(context);
          const profile = contexts.length;
          context.on("weberror", (error) =>
            browserErrors.push(`Profile ${profile}: ${error.error().message}`),
          );
          const page = await context.newPage();
          await page.clock.setFixedTime(new Date(FIXED_TIME));
          return new NeoseqApp(page);
        },
      });
    } finally {
      // Playwright Test records contexts created through its browser fixture,
      // including these additional profiles, in the configured failure trace.
      for (const context of contexts) await context.close();
      // The public API retains account audit history; remove test graphs and
      // disable each temporary identity, which also revokes all its sessions.
      for (const account of accounts) {
        if (account.token) {
          for (const graph of await catalog(account)) {
            if (graph.role !== "owner") continue;
            const response = await request.delete(`${origin}/v1/graphs/${graph.graph_id}`, {
              headers: { authorization: `Bearer ${account.token}` },
            });
            expect(response.status(), "remove the test-owned server graph").toBe(204);
          }
        }
        const response = await request.patch(`${origin}/v1/admin/accounts/${account.accountId}`, {
          headers: adminHeaders,
          data: { status: "disabled" },
        });
        expect(response.status(), "disable the temporary test account").toBe(200);
      }
      expect(browserErrors, "uncaught errors in independent browser profiles").toEqual([]);
    }
  },
});

export async function addRepository(
  page: Page,
  origin: string,
  account: RemoteAccount,
  persistent = true,
): Promise<void> {
  await page.getByTestId("add-repository").click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Server URL").fill(origin);
  await dialog.getByLabel("Username", { exact: true }).fill(account.username);
  await dialog.getByLabel("Password", { exact: true }).fill(account.password);
  await dialog.getByLabel("Keep me signed in on this browser").setChecked(persistent);
  await dialog.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(repositoryTab(page, origin, account)).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("tabpanel")).toHaveAttribute("aria-busy", "false");
}

export function repositoryTab(page: Page, origin: string, account: RemoteAccount) {
  return page.getByRole("tab", {
    name: `${account.username}@${new URL(origin).host}`,
    exact: true,
  });
}

export async function createRemote(
  app: NeoseqApp,
  remote: RemoteServer,
  name: string,
): Promise<void> {
  await app.page.goto("/");
  await addRepository(app.page, remote.origin, remote.owner);
  await createInSelectedRepository(app.page, name);
}

export async function createInSelectedRepository(page: Page, name: string): Promise<void> {
  await page.getByTestId("new-graph").click();
  await page.getByTestId("new-graph-name").fill(name);
  await page.getByTestId("create-graph").click();
  await expect(page.getByTestId("journal-title")).toBeVisible();
  await expectSynced(page);
  // The first wait for the server's copy is a passing condition; its notice
  // must leave with it rather than cover the page's controls.
  await expect(
    page.getByTestId("toast").filter({ hasText: "Waiting for the server’s copy" }),
  ).toHaveCount(0);
}

export async function openRemote(
  app: NeoseqApp,
  remote: RemoteServer,
  account: RemoteAccount,
  graphName: string,
  pageTitle?: string,
): Promise<void> {
  await app.page.goto("/");
  await addRepository(app.page, remote.origin, account);
  await app.page.getByTestId(`open-graph-${graphName}`).click();
  await expectSynced(app.page);
  if (pageTitle) {
    await app.page
      .getByTestId("page-list")
      .getByRole("link", { name: pageTitle, exact: true })
      .click();
    await expect(app.page.getByTestId("page-title")).toHaveValue(pageTitle);
  } else {
    await expect(app.page.getByTestId("journal-title")).toBeVisible();
  }
}

export async function expectSynced(page: Page): Promise<void> {
  await expect(page.getByTestId("live-status")).toHaveAttribute("data-live", "live");
  await expect(page.getByTestId("save-status")).toHaveAttribute("data-save", "saved");
  await expect(page.getByTestId("sync-status")).toHaveAttribute("data-sync", "synced");
}

export async function invite(page: Page, account: RemoteAccount): Promise<void> {
  await openMembers(page);
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Username", { exact: true }).fill(account.username);
  await dialog.getByRole("button", { name: "Invite", exact: true }).click();
  await expect(dialog.getByRole("listitem").filter({ hasText: account.username })).toContainText(
    "Editor",
  );
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
}

export async function revoke(page: Page, account: RemoteAccount): Promise<void> {
  await openMembers(page);
  const dialog = page.getByRole("dialog");
  const member = dialog.getByRole("listitem").filter({ hasText: account.username });
  await member.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(member).toHaveCount(0);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
}

async function openMembers(page: Page): Promise<void> {
  await page.getByTestId("graph-switcher").click();
  await page.getByRole("menuitem", { name: "Manage members", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("list")).toHaveAttribute("aria-busy", "false");
}

export function graphId(page: Page): string {
  const parsed = new URL(page.url());
  const route = parsed.hash.startsWith("#/") ? parsed.hash.slice(1) : parsed.pathname;
  const match = route.match(/\/g\/([^/]+)/u);
  if (!match) throw new Error(`expected a graph route, received ${page.url()}`);
  return decodeURIComponent(match[1]);
}

async function login(
  request: APIRequestContext,
  origin: string,
  username: string,
  password: string,
  purpose: "admin" | "client",
): Promise<string> {
  const response = await request.post(`${origin}/v1/auth/login`, {
    data: { username, password, purpose },
  });
  expect(response.status(), `authenticate ${purpose} against the real sync server`).toBe(200);
  return ((await response.json()) as { access_token: string }).access_token;
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`${name} is required: run the browser gate with its real sync server`);
  return value;
}
