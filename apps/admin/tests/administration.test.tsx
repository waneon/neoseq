import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import * as api from "@/api";
import { ApiError, type Account } from "@/api";
import { App } from "@/app/App";
import { LocaleProvider } from "@/i18n";

vi.mock("@/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api")>()),
  login: vi.fn(),
  logout: vi.fn(),
  listAccounts: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  resetPassword: vi.fn(),
  revokeSessions: vi.fn(),
}));

function account(username: string, overrides: Partial<Account> = {}): Account {
  return {
    account_id: `id-${username}`,
    username,
    status: "active",
    server_role: "user",
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

const ROOT = account("root", { server_role: "admin" });
const ALICE = account("Alice");

async function signIn(directory: readonly Account[] = [ROOT, ALICE]) {
  vi.mocked(api.login).mockResolvedValue({ access_token: "token", account: ROOT });
  vi.mocked(api.listAccounts).mockResolvedValue([...directory]);
  const user = userEvent.setup();
  render(
    <LocaleProvider>
      <App />
    </LocaleProvider>,
  );
  await user.type(screen.getByLabelText("User ID"), "root");
  await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
  await user.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByRole("heading", { name: "Accounts" });
  return user;
}

function actions(username: string) {
  return within(screen.getByRole("group", { name: `Actions for ${username}` }));
}

describe("account directory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem("neoseq.admin.locale.v1", "en");
  });

  it("presents each account's username, state, and global role", async () => {
    await signIn([ROOT, account("bob", { status: "disabled" })]);

    const list = within(screen.getByRole("list"));
    expect(list.getByText("root")).toBeVisible();
    expect(list.getByText("Administrator")).toBeVisible();
    expect(list.getByText("Disabled")).toBeVisible();
    // The opaque account ID stays operational metadata, not part of the row.
    expect(screen.queryByText(/id-root/)).toBeNull();
  });

  it("narrows the directory without regard to case and without asking the server", async () => {
    const user = await signIn();

    await user.type(screen.getByRole("searchbox", { name: "Search accounts" }), "ALI");

    const list = within(screen.getByRole("list"));
    expect(list.getByText("Alice")).toBeVisible();
    expect(list.queryByText("root")).toBeNull();
    // The field shows what was typed; only the comparison is case-folded.
    expect(screen.getByRole("searchbox", { name: "Search accounts" })).toHaveValue("ALI");
    expect(api.listAccounts).toHaveBeenCalledTimes(1);
  });

  it("withholds the two verbs the last active administrator may not be given, and says why", async () => {
    await signIn();

    const root = actions("root");
    expect(root.getByRole("button", { name: "Disable" })).toBeDisabled();
    expect(root.getByRole("button", { name: "Remove administrator" })).toBeDisabled();
    expect(screen.getByText("Last active administrator")).toBeVisible();

    // A second administrator releases the constraint on the first.
    expect(actions("Alice").getByRole("button", { name: "Disable" })).toBeEnabled();
  });

  it("states the consequence of disabling an account and commits only once confirmed", async () => {
    const user = await signIn();

    await user.click(actions("Alice").getByRole("button", { name: "Disable" }));
    const dialog = within(await screen.findByRole("alertdialog"));
    expect(dialog.getByText(/every session they hold ends immediately/i)).toBeVisible();
    expect(api.updateAccount).not.toHaveBeenCalled();

    vi.mocked(api.updateAccount).mockResolvedValue(account("Alice", { status: "disabled" }));
    vi.mocked(api.listAccounts).mockResolvedValue([ROOT, account("Alice", { status: "disabled" })]);
    await user.click(dialog.getByRole("button", { name: "Disable account" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.updateAccount).toHaveBeenCalledWith("token", "id-Alice", { status: "disabled" });
    // The new state is read back from the server rather than assumed.
    expect(api.listAccounts).toHaveBeenCalledTimes(2);
    expect(within(screen.getByRole("list")).getByText("Disabled")).toBeVisible();
  });

  it("abandons a confirmation without touching the server", async () => {
    const user = await signIn();

    await user.click(actions("Alice").getByRole("button", { name: "Revoke sessions" }));
    const dialog = within(await screen.findByRole("alertdialog"));
    await user.click(dialog.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.revokeSessions).not.toHaveBeenCalled();
  });

  it("reports a refused confirmation inside the dialog that asked for it", async () => {
    const user = await signIn();

    await user.click(actions("Alice").getByRole("button", { name: "Revoke sessions" }));
    const dialog = within(await screen.findByRole("alertdialog"));
    vi.mocked(api.revokeSessions).mockRejectedValue(new ApiError(500, "boom"));
    await user.click(dialog.getByRole("button", { name: "Revoke sessions" }));

    expect(await dialog.findByRole("alert")).toHaveTextContent(
      "The request could not be completed.",
    );
    // The dialog owns the operation's lifetime: a failure leaves it up.
    expect(screen.getByRole("alertdialog")).toBeVisible();
  });

  it("reports a refused promotion on the row that raised it", async () => {
    const user = await signIn();

    vi.mocked(api.updateAccount).mockRejectedValue(new ApiError(409, "last admin"));
    await user.click(actions("Alice").getByRole("button", { name: "Make administrator" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The last active administrator cannot be disabled or demoted.",
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("names the conflict a new account can actually have", async () => {
    const user = await signIn();

    vi.mocked(api.createAccount).mockRejectedValue(new ApiError(409, "account already exists"));
    await user.type(screen.getByLabelText("Username"), "Alice");
    await user.type(screen.getByLabelText("Initial password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: "Add account" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "An account with that username already exists.",
    );
  });

  it("refuses a password the server would refuse, and says the rule", async () => {
    await signIn();

    expect(screen.getByText("At least 15 characters.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Add account" })).toBeDisabled();
  });

  it("returns to sign-in when the administrative session has ended", async () => {
    const user = await signIn();

    vi.mocked(api.updateAccount).mockRejectedValue(new ApiError(401, "unauthorized"));
    await user.click(actions("Alice").getByRole("button", { name: "Make administrator" }));

    expect(await screen.findByRole("heading", { name: "Administrator sign in" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Your administrator session ended.");
  });

  it("offers a way back when the directory could not be read", async () => {
    vi.mocked(api.login).mockResolvedValue({ access_token: "token", account: ROOT });
    vi.mocked(api.listAccounts).mockRejectedValue(new ApiError(0, "offline"));
    const user = userEvent.setup();
    render(
      <LocaleProvider>
        <App />
      </LocaleProvider>,
    );
    await user.type(screen.getByLabelText("User ID"), "root");
    await user.type(screen.getByLabelText("Password"), "a-long-enough-password");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The sync server could not be reached.",
    );
    // Reloading would end the memory-only session, so the retry is the way out.
    vi.mocked(api.listAccounts).mockResolvedValue([ROOT, ALICE]);
    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("list")).toBeVisible();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("keeps no administrative authority in Web storage", async () => {
    await signIn();

    const stored = Object.entries(localStorage).map(([key, value]) => `${key}=${value}`);
    expect(stored.join("\n")).not.toContain("token");
  });
});
