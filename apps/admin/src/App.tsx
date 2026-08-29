import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  createAccount,
  listAccounts,
  login,
  logout,
  resetPassword,
  revokeSessions,
  updateAccount,
  type Account,
  type ServerRole,
} from "./api";
import { LOCALE_DEFINITIONS, useI18n, type LocalePreference, type MessageFunction } from "./i18n";

type AdminErrorKey = "error.conflict" | "error.generic" | "error.invalidInput";

interface Session {
  token: string;
  username: string;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  return session ? (
    <Dashboard session={session} onSignedOut={() => setSession(null)} />
  ) : (
    <Login onSignedIn={setSession} />
  );
}

function Login({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const { message } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [invalidCredentials, setInvalidCredentials] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setInvalidCredentials(false);
    try {
      const result = await login(username, password);
      onSignedIn({ token: result.access_token, username: result.account.username });
    } catch {
      setInvalidCredentials(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-card-header">
          <Brand />
          <LanguageControl />
        </div>
        <div className="login-copy">
          <p className="eyebrow">{message("login.eyebrow")}</p>
          <h1 id="login-title">{message("login.title")}</h1>
          <p>{message("login.description")}</p>
        </div>
        {invalidCredentials && <Notice>{message("login.error")}</Notice>}
        <form onSubmit={submit} className="stack">
          <Field label={message("login.username")} htmlFor="username">
            <input
              id="username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field label={message("login.password")} htmlFor="password">
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <button className="primary" disabled={busy || !username.trim() || !password}>
            {busy ? message("login.checking") : message("login.action")}
          </button>
        </form>
      </section>
    </main>
  );
}

function Dashboard({ session, onSignedOut }: { session: Session; onSignedOut: () => void }) {
  const { formatNumber, locale, message } = useI18n();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<AdminErrorKey | null>(null);
  const [resetTarget, setResetTarget] = useState<Account | null>(null);
  const resetTrigger = useRef<HTMLButtonElement | null>(null);

  const handleError = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
        onSignedOut();
      } else {
        setError(messageKeyFor(cause));
      }
    },
    [onSignedOut],
  );

  const refresh = useCallback(async () => {
    try {
      setAccounts(await listAccounts(session.token));
      setError(null);
    } catch (cause) {
      handleError(cause);
    }
  }, [handleError, session.token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mutate = async (accountId: string, operation: () => Promise<unknown>) => {
    setBusyId(accountId);
    setError(null);
    try {
      await operation();
      await refresh();
    } catch (cause) {
      handleError(cause);
    } finally {
      setBusyId(null);
    }
  };

  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase(locale);
    return needle ? accounts.filter((account) => account.username.includes(needle)) : accounts;
  }, [accounts, locale, query]);

  const active = accounts.filter((account) => account.status === "active").length;
  const admins = accounts.filter((account) => account.server_role === "admin").length;

  return (
    <div className="app-shell">
      <header className="topbar" inert={resetTarget ? true : undefined}>
        <Brand />
        <div className="admin-session">
          <LanguageControl />
          <span>
            <strong dir="auto">{session.username}</strong>
            <small>{message("session.role")}</small>
          </span>
          <button
            className="quiet"
            onClick={() => {
              void logout(session.token).finally(onSignedOut);
            }}
          >
            {message("session.logout")}
          </button>
        </div>
      </header>

      <main className="workspace" inert={resetTarget ? true : undefined}>
        <section className="page-heading">
          <div>
            <p className="eyebrow">{message("accounts.eyebrow")}</p>
            <h1>{message("accounts.title")}</h1>
            <p>{message("accounts.description")}</p>
          </div>
          <dl className="summary" aria-label={message("accounts.summary.label")}>
            <div>
              <dt>{message("accounts.summary.total")}</dt>
              <dd>{formatNumber(accounts.length)}</dd>
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
        </section>

        {error && <Notice>{message(error)}</Notice>}

        <section className="panel create-panel" aria-labelledby="create-title">
          <div>
            <h2 id="create-title">{message("create.title")}</h2>
            <p>{message("create.passwordHint")}</p>
          </div>
          <CreateAccountForm token={session.token} onCreated={refresh} onError={handleError} />
        </section>

        <section className="accounts-section" aria-labelledby="accounts-title">
          <div className="list-heading">
            <h2 id="accounts-title">{message("accounts.list.title")}</h2>
            <label className="search-field">
              <span className="sr-only">{message("accounts.search.label")}</span>
              <input
                type="search"
                placeholder={message("accounts.search.placeholder")}
                value={query}
                onChange={(event) => setQuery(event.target.value.toLocaleLowerCase(locale))}
              />
            </label>
          </div>
          <div className="account-list">
            {visible.map((account) => (
              <article className="account-row" key={account.account_id}>
                <div className="account-identity">
                  <span className="avatar" aria-hidden="true">
                    {account.username.slice(0, 1).toUpperCase()}
                  </span>
                  <span>
                    <strong dir="auto">{account.username}</strong>
                  </span>
                </div>
                <div className="badges">
                  <span className={`badge ${account.status}`}>{statusLabel(account, message)}</span>
                  {account.server_role === "admin" && (
                    <span className="badge admin">{message("accounts.badge.admin")}</span>
                  )}
                </div>
                <div className="row-actions">
                  <button
                    className="quiet"
                    disabled={busyId === account.account_id}
                    onClick={(event) => {
                      resetTrigger.current = event.currentTarget;
                      setResetTarget(account);
                    }}
                  >
                    {message("accounts.action.resetPassword")}
                  </button>
                  <button
                    className="quiet"
                    disabled={busyId === account.account_id}
                    onClick={() => {
                      if (
                        !window.confirm(
                          message("accounts.confirm.revokeSessions", {
                            username: account.username,
                          }),
                        )
                      )
                        return;
                      void mutate(account.account_id, () =>
                        revokeSessions(session.token, account.account_id),
                      );
                    }}
                  >
                    {message("accounts.action.revokeSessions")}
                  </button>
                  <button
                    className="quiet"
                    disabled={busyId === account.account_id}
                    onClick={() => {
                      if (
                        account.server_role === "admin" &&
                        !window.confirm(
                          message("accounts.confirm.demote", { username: account.username }),
                        )
                      )
                        return;
                      void mutate(account.account_id, () =>
                        updateAccount(session.token, account.account_id, {
                          server_role: account.server_role === "admin" ? "user" : "admin",
                        }),
                      );
                    }}
                  >
                    {account.server_role === "admin"
                      ? message("accounts.action.demote")
                      : message("accounts.action.promote")}
                  </button>
                  <button
                    className={account.status === "active" ? "danger" : "quiet"}
                    disabled={busyId === account.account_id}
                    onClick={() => {
                      if (
                        account.status === "active" &&
                        !window.confirm(
                          message("accounts.confirm.disable", { username: account.username }),
                        )
                      )
                        return;
                      void mutate(account.account_id, () =>
                        updateAccount(session.token, account.account_id, {
                          status: account.status === "active" ? "disabled" : "active",
                        }),
                      );
                    }}
                  >
                    {account.status === "active"
                      ? message("accounts.action.disable")
                      : message("accounts.action.activate")}
                  </button>
                </div>
              </article>
            ))}
            {visible.length === 0 && <p className="empty">{message("accounts.empty")}</p>}
          </div>
        </section>
      </main>

      {resetTarget && (
        <ResetPasswordDialog
          account={resetTarget}
          token={session.token}
          onClose={() => {
            setResetTarget(null);
            window.requestAnimationFrame(() => resetTrigger.current?.focus());
          }}
          onReset={refresh}
          onError={handleError}
        />
      )}
    </div>
  );
}

function CreateAccountForm({
  token,
  onCreated,
  onError,
}: {
  token: string;
  onCreated: () => Promise<void>;
  onError: (cause: unknown) => void;
}) {
  const { message } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<ServerRole>("user");
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await createAccount(token, { username, password, server_role: role });
      setUsername("");
      setPassword("");
      setRole("user");
      await onCreated();
    } catch (cause) {
      onError(cause);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="create-form" onSubmit={submit}>
      <Field label={message("login.username")} htmlFor="new-username">
        <input
          id="new-username"
          autoComplete="off"
          placeholder="alice"
          value={username}
          onChange={(event) => setUsername(event.target.value.toLowerCase())}
        />
      </Field>
      <Field label={message("create.initialPassword")} htmlFor="new-password">
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Field label={message("create.role")} htmlFor="new-role">
        <select
          id="new-role"
          value={role}
          onChange={(event) => setRole(event.target.value as ServerRole)}
        >
          <option value="user">{message("role.user")}</option>
          <option value="admin">{message("role.admin")}</option>
        </select>
      </Field>
      <button
        className="primary compact"
        disabled={busy || !username || characterCount(password) < 15}
      >
        {busy ? message("create.adding") : message("create.action")}
      </button>
    </form>
  );
}

function ResetPasswordDialog({
  account,
  token,
  onClose,
  onReset,
  onError,
}: {
  account: Account;
  token: string;
  onClose: () => void;
  onReset: () => Promise<void>;
  onError: (cause: unknown) => void;
}) {
  const { message } = useI18n();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = dialog.current?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])",
      );
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialog}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="reset-title"
        aria-describedby="reset-detail"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <p className="eyebrow">{message("reset.eyebrow")}</p>
        <h2 id="reset-title">{message("reset.title", { username: account.username })}</h2>
        <p id="reset-detail">{message("reset.description")}</p>
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            try {
              await resetPassword(token, account.account_id, password);
              await onReset();
              onClose();
            } catch (cause) {
              onError(cause);
              setBusy(false);
            }
          }}
        >
          <Field label={message("reset.newPassword")} htmlFor="reset-password">
            <input
              id="reset-password"
              type="password"
              autoComplete="new-password"
              autoFocus
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <div className="modal-actions">
            <button type="button" className="quiet" onClick={onClose} disabled={busy}>
              {message("reset.cancel")}
            </button>
            <button className="primary" disabled={busy || characterCount(password) < 15}>
              {message("reset.action")}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <label className="field" htmlFor={htmlFor}>
      <span>{label}</span>
      {children}
    </label>
  );
}

function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark" aria-hidden="true">
        N
      </span>
      <span>neoseq</span>
    </div>
  );
}

function LanguageControl() {
  const { message, preference, setPreference } = useI18n();
  return (
    <label className="language-control">
      <span className="sr-only">{message("language.control")}</span>
      <select
        aria-label={message("language.control")}
        value={preference}
        onChange={(event) => setPreference(event.target.value as LocalePreference)}
      >
        <option value="system">{message("language.system")}</option>
        {LOCALE_DEFINITIONS.map((definition) => (
          <option key={definition.tag} value={definition.tag}>
            {message(definition.labelKey)}
          </option>
        ))}
      </select>
    </label>
  );
}

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="notice" role="alert">
      {children}
    </p>
  );
}

function statusLabel(account: Account, message: MessageFunction) {
  return account.status === "active"
    ? message("accounts.badge.active")
    : message("accounts.badge.disabled");
}

function characterCount(value: string) {
  return Array.from(value).length;
}

function messageKeyFor(cause: unknown): AdminErrorKey {
  if (!(cause instanceof ApiError)) return "error.generic";
  if (cause.status === 409) return "error.conflict";
  if (cause.status === 400) return "error.invalidInput";
  return "error.generic";
}
