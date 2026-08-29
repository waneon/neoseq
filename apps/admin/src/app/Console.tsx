// The signed-in surface: one bar, one column, and the directory in it.

import { useCallback, useEffect, useState } from "react";

import { ApiError, listAccounts, logout, type Account } from "@/api";
import { useI18n } from "@/i18n";
import { Button } from "@/ui/shadcn/button";
import { LogoMark } from "@/ui/brand";
import { AccountDirectory } from "./AccountDirectory";
import { CreateAccount } from "./CreateAccount";
import { LanguageControl, ThemeControl } from "./Appearance";
import { failureMessage, type Perform, type Session } from "./session";

export function Console({
  session,
  onSignOut,
}: {
  session: Session;
  onSignOut: (reason: "operator" | "expired") => void;
}) {
  const { formatNumber, message } = useI18n();
  const [accounts, setAccounts] = useState<readonly Account[] | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);

  const expire = useCallback(() => onSignOut("expired"), [onSignOut]);

  const refresh = useCallback(async () => {
    try {
      setAccounts(await listAccounts(session.token));
      setLoadFailure(null);
    } catch (cause) {
      if (cause instanceof ApiError && cause.isUnauthorized) expire();
      else setLoadFailure(failureMessage(message, cause));
    }
  }, [expire, message, session.token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const perform = useCallback<Perform>(
    async (operation) => {
      try {
        await operation();
      } catch (cause) {
        // An expired session is a fact about the app, not about this request.
        if (cause instanceof ApiError && cause.isUnauthorized) {
          expire();
          return;
        }
        throw cause;
      }
      await refresh();
    },
    [expire, refresh],
  );

  const total = accounts?.length ?? 0;
  const active = (accounts ?? []).filter((account) => account.status === "active").length;
  const admins = (accounts ?? []).filter((account) => account.server_role === "admin").length;

  return (
    <div className="console">
      <a className="skip-link" href="#directory">
        {message("console.skipToDirectory")}
      </a>
      <header className="console-topbar">
        <div>
          <p className="console-brand">
            <LogoMark aria-hidden />
            <span>{message("admin.wordmark")}</span>
            <span className="wordmark-role">{message("admin.wordmarkRole")}</span>
          </p>
          <div className="console-actions">
            <ThemeControl />
            <LanguageControl />
            <p className="console-operator">
              <strong dir="auto">{session.username}</strong>
              <span>{message("console.role")}</span>
            </p>
            <Button
              variant="ghost"
              onClick={() => {
                // The session is memory-only, so the operator leaves the moment
                // they ask to; telling the server is a courtesy that must not be
                // able to keep them here.
                void logout(session.token).catch(() => undefined);
                onSignOut("operator");
              }}
            >
              {message("console.signOut")}
            </Button>
          </div>
        </div>
      </header>

      <main className="console-main">
        <div className="console-heading">
          <div>
            <h1>{message("accounts.title")}</h1>
            <p>{message("accounts.lede")}</p>
          </div>
          <dl className="summary" aria-label={message("accounts.summary.label")}>
            <div>
              <dt>{message("accounts.summary.total")}</dt>
              <dd>{formatNumber(total)}</dd>
            </div>
            <div>
              <dt>{message("accounts.summary.active")}</dt>
              <dd>{formatNumber(active)}</dd>
            </div>
            <div>
              <dt>{message("accounts.summary.admins")}</dt>
              <dd>{formatNumber(admins)}</dd>
            </div>
          </dl>
        </div>

        <CreateAccount token={session.token} perform={perform} />
        <AccountDirectory
          accounts={accounts}
          loadFailure={loadFailure}
          onRetry={() => void refresh()}
          token={session.token}
          perform={perform}
        />
      </main>
    </div>
  );
}
