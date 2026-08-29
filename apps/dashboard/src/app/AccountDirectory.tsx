// The account directory: the primary surface of this app.
//
// Search narrows it without changing server state. Each row presents the
// username first, then whether the account is in service and what it may
// administer, then its verbs — every one of them visible, because an operator
// must not have to hover to discover what can be done to an account
// (designs/server-administration.md § Information and Interaction).

import { useMemo, useState } from "react";
import { SearchIcon, ShieldIcon } from "lucide-react";

import { revokeSessions, updateAccount, type Account } from "@/api";
import { usePastFlashThreshold } from "@/lib/flash";
import { useI18n } from "@/i18n";
import { Button } from "@/ui/shadcn/button";
import { Input } from "@/ui/shadcn/input";
import { Callout, ConfirmDialog } from "@/ui/components";
import { failureMessage, type Perform } from "./session";
import { ResetPassword } from "./ResetPassword";

/** The three operations that state their consequence before they commit. */
type Consequence = "revokeSessions" | "demote" | "disable";

const CONSEQUENCE = {
  revokeSessions: {
    title: "confirm.revokeSessions.title",
    body: "confirm.revokeSessions.body",
    action: "confirm.revokeSessions.action",
  },
  demote: {
    title: "confirm.demote.title",
    body: "confirm.demote.body",
    action: "confirm.demote.action",
  },
  disable: {
    title: "confirm.disable.title",
    body: "confirm.disable.body",
    action: "confirm.disable.action",
  },
} as const;

interface Confirmation {
  account: Account;
  consequence: Consequence;
}

/**
 * The two verbs that toggle. Each has one direction that reduces what an account
 * may do — and therefore states its consequence first — and one that restores it,
 * which commits where it stands.
 */
type Verb = "role" | "status";

interface Pending {
  accountId: string;
  verb: Verb;
}

export function AccountDirectory({
  accounts,
  loadFailure,
  onRetry,
  token,
  perform,
}: {
  /** `null` until the first read has answered. */
  accounts: readonly Account[] | null;
  loadFailure: string | null;
  onRetry: () => void;
  token: string;
  perform: Perform;
}) {
  const { locale, message } = useI18n();
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<Pending | null>(null);
  const [rowFailure, setRowFailure] = useState<{ accountId: string; text: string } | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [resetTarget, setResetTarget] = useState<Account | null>(null);
  // A read that has not answered yet is not news until it has been slow; a
  // spinner that appears and vanishes inside 200ms is a flicker, not a report.
  const loading = usePastFlashThreshold(accounts === null && loadFailure === null);

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale);
    if (!needle || !accounts) return accounts;
    return accounts.filter((account) =>
      account.username.toLocaleLowerCase(locale).includes(needle),
    );
  }, [accounts, locale, query]);

  // The server is the authority on this rule; the count is what lets the row say
  // so before the operator asks, rather than after being refused.
  const activeAdmins = (accounts ?? []).filter(
    (account) => account.status === "active" && account.server_role === "admin",
  ).length;

  const refuse = (cause: unknown) => failureMessage(message, cause, { 409: "error.lastAdmin" });

  /**
   * Commits a verb that adds capability, and so states no consequence.
   *
   * One at a time across the whole directory, not merely per row: every commit
   * re-reads the list, and two of them in flight would land their answers in
   * whichever order the network chose.
   */
  const commit = async (account: Account, verb: Verb, operation: () => Promise<unknown>) => {
    if (pending) return;
    setPending({ accountId: account.account_id, verb });
    setRowFailure(null);
    try {
      await perform(operation);
    } catch (cause) {
      setRowFailure({ accountId: account.account_id, text: refuse(cause) });
    } finally {
      setPending(null);
    }
  };

  const operationFor = ({ account, consequence }: Confirmation) => {
    switch (consequence) {
      case "revokeSessions":
        return revokeSessions(token, account.account_id);
      case "demote":
        return updateAccount(token, account.account_id, { server_role: "user" });
      case "disable":
        return updateAccount(token, account.account_id, { status: "disabled" });
    }
  };

  return (
    <section id="directory" aria-labelledby="directory-title">
      <div className="directory-heading">
        <h2 id="directory-title">{message("accounts.list.title")}</h2>
        <div className="search-field">
          <SearchIcon aria-hidden />
          <Input
            type="search"
            className="ps-8 pe-2.5"
            aria-label={message("accounts.search.label")}
            placeholder={message("accounts.search.placeholder")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
      </div>

      {/* Reloading the page would end the session, so a directory that could not
          be read offers the one thing that gets the operator out of the state. */}
      {loadFailure && (
        <Callout
          action={
            <Button variant="ghost" onClick={onRetry}>
              {message("accounts.retry")}
            </Button>
          }
        >
          {loadFailure}
        </Callout>
      )}

      {visible === null ? (
        loading && (
          <p className="directory-loading" role="status">
            <span className="spinner" aria-hidden />
            {message("accounts.loading")}
          </p>
        )
      ) : visible.length === 0 ? (
        <p className="directory-empty">
          {accounts?.length === 0
            ? message("accounts.empty")
            : message("accounts.noMatches", { query: query.trim() })}
        </p>
      ) : (
        // Safari drops list semantics from a list whose markers are removed.
        <ul className="directory" role="list">
          {visible.map((account) => {
            const active = account.status === "active";
            const admin = account.server_role === "admin";
            const lastAdmin = active && admin && activeAdmins === 1;
            const busy = pending?.accountId === account.account_id;
            const failure = rowFailure?.accountId === account.account_id ? rowFailure.text : null;
            return (
              <li className="account-row" key={account.account_id}>
                <span className="account-name" dir="auto">
                  {account.username}
                </span>
                <span className="account-marks">
                  <span className="chip" data-palette={active ? "ok" : "neutral"}>
                    {active ? message("accounts.state.active") : message("accounts.state.disabled")}
                  </span>
                  {admin && (
                    <span className="chip" data-palette="info">
                      <ShieldIcon aria-hidden />
                      {message("accounts.role.admin")}
                    </span>
                  )}
                </span>
                <div
                  className="account-actions"
                  role="group"
                  aria-label={message("accounts.rowActions", { username: account.username })}
                >
                  <Button variant="ghost" disabled={busy} onClick={() => setResetTarget(account)}>
                    {message("accounts.action.resetPassword")}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setConfirmation({ account, consequence: "revokeSessions" })}
                  >
                    {message("accounts.action.revokeSessions")}
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy || lastAdmin}
                    onClick={() => {
                      if (admin) setConfirmation({ account, consequence: "demote" });
                      else
                        void commit(account, "role", () =>
                          updateAccount(token, account.account_id, { server_role: "admin" }),
                        );
                    }}
                  >
                    {busy && pending?.verb === "role" && <span className="spinner" aria-hidden />}
                    {admin ? message("accounts.action.demote") : message("accounts.action.promote")}
                  </Button>
                  <Button
                    variant={active ? "destructive" : "ghost"}
                    disabled={busy || lastAdmin}
                    onClick={() => {
                      if (active) setConfirmation({ account, consequence: "disable" });
                      else
                        void commit(account, "status", () =>
                          updateAccount(token, account.account_id, { status: "active" }),
                        );
                    }}
                  >
                    {busy && pending?.verb === "status" && <span className="spinner" aria-hidden />}
                    {active
                      ? message("accounts.action.disable")
                      : message("accounts.action.activate")}
                  </Button>
                </div>
                {lastAdmin && <p className="account-note">{message("accounts.lastAdmin")}</p>}
                {failure && (
                  <div className="account-row-failure">
                    <Callout>{failure}</Callout>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {confirmation && (
        <ConfirmDialog
          title={message(CONSEQUENCE[confirmation.consequence].title, {
            username: confirmation.account.username,
          })}
          description={message(CONSEQUENCE[confirmation.consequence].body, {
            username: confirmation.account.username,
          })}
          cancelLabel={message("confirm.cancel")}
          confirmLabel={message(CONSEQUENCE[confirmation.consequence].action)}
          onCancel={() => setConfirmation(null)}
          onConfirm={async () => {
            await perform(() => operationFor(confirmation));
            setConfirmation(null);
          }}
          errorMessage={refuse}
        />
      )}

      {resetTarget && (
        <ResetPassword
          account={resetTarget}
          token={token}
          perform={perform}
          onClose={() => setResetTarget(null)}
        />
      )}
    </section>
  );
}
