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
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result = await login(username, password);
      onSignedIn({ token: result.access_token, username: result.account.username });
    } catch {
      setError("관리자 ID 또는 비밀번호를 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-shell">
      <section className="login-card" aria-labelledby="login-title">
        <Brand />
        <div className="login-copy">
          <p className="eyebrow">Sync server</p>
          <h1 id="login-title">관리자 로그인</h1>
          <p>사용자 계정과 접속 세션을 관리합니다.</p>
        </div>
        {error && <Notice>{error}</Notice>}
        <form onSubmit={submit} className="stack">
          <Field label="사용자 ID" htmlFor="username">
            <input
              id="username"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </Field>
          <Field label="비밀번호" htmlFor="password">
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </Field>
          <button className="primary" disabled={busy || !username.trim() || !password}>
            {busy ? "확인하는 중…" : "로그인"}
          </button>
        </form>
      </section>
    </main>
  );
}

function Dashboard({ session, onSignedOut }: { session: Session; onSignedOut: () => void }) {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [resetTarget, setResetTarget] = useState<Account | null>(null);
  const resetTrigger = useRef<HTMLButtonElement | null>(null);

  const handleError = useCallback(
    (cause: unknown) => {
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) {
        onSignedOut();
      } else {
        setError(messageFor(cause));
      }
    },
    [onSignedOut],
  );

  const refresh = useCallback(async () => {
    try {
      setAccounts(await listAccounts(session.token));
      setError("");
    } catch (cause) {
      handleError(cause);
    }
  }, [handleError, session.token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const mutate = async (accountId: string, operation: () => Promise<unknown>) => {
    setBusyId(accountId);
    setError("");
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
    const needle = query.trim().toLowerCase();
    return needle ? accounts.filter((account) => account.username.includes(needle)) : accounts;
  }, [accounts, query]);

  const active = accounts.filter((account) => account.status === "active").length;
  const admins = accounts.filter((account) => account.server_role === "admin").length;

  return (
    <div className="app-shell">
      <header className="topbar" inert={resetTarget ? true : undefined}>
        <Brand />
        <div className="admin-session">
          <span>
            <strong>{session.username}</strong>
            <small>서버 관리자</small>
          </span>
          <button
            className="quiet"
            onClick={() => {
              void logout(session.token).finally(onSignedOut);
            }}
          >
            로그아웃
          </button>
        </div>
      </header>

      <main className="workspace" inert={resetTarget ? true : undefined}>
        <section className="page-heading">
          <div>
            <p className="eyebrow">Accounts</p>
            <h1>사용자 계정</h1>
            <p>로그인 자격과 서버 접근 상태를 관리합니다.</p>
          </div>
          <dl className="summary" aria-label="계정 요약">
            <div>
              <dt>전체</dt>
              <dd>{accounts.length}</dd>
            </div>
            <div>
              <dt>활성</dt>
              <dd>{active}</dd>
            </div>
            <div>
              <dt>관리자</dt>
              <dd>{admins}</dd>
            </div>
          </dl>
        </section>

        {error && <Notice>{error}</Notice>}

        <section className="panel create-panel" aria-labelledby="create-title">
          <div>
            <h2 id="create-title">새 계정</h2>
            <p>비밀번호는 15자 이상이어야 합니다.</p>
          </div>
          <CreateAccountForm token={session.token} onCreated={refresh} onError={handleError} />
        </section>

        <section className="accounts-section" aria-labelledby="accounts-title">
          <div className="list-heading">
            <h2 id="accounts-title">계정 목록</h2>
            <label className="search-field">
              <span className="sr-only">사용자 ID 검색</span>
              <input
                type="search"
                placeholder="사용자 ID 검색"
                value={query}
                onChange={(event) => setQuery(event.target.value.toLowerCase())}
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
                    <strong>{account.username}</strong>
                  </span>
                </div>
                <div className="badges">
                  <span className={`badge ${account.status}`}>{statusLabel(account)}</span>
                  {account.server_role === "admin" && <span className="badge admin">관리자</span>}
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
                    비밀번호 재설정
                  </button>
                  <button
                    className="quiet"
                    disabled={busyId === account.account_id}
                    onClick={() => {
                      if (!window.confirm(`${account.username}의 모든 로그인 세션을 종료할까요?`))
                        return;
                      void mutate(account.account_id, () =>
                        revokeSessions(session.token, account.account_id),
                      );
                    }}
                  >
                    세션 종료
                  </button>
                  <button
                    className="quiet"
                    disabled={busyId === account.account_id}
                    onClick={() => {
                      if (
                        account.server_role === "admin" &&
                        !window.confirm(`${account.username}의 서버 관리자 권한을 해제할까요?`)
                      )
                        return;
                      void mutate(account.account_id, () =>
                        updateAccount(session.token, account.account_id, {
                          server_role: account.server_role === "admin" ? "user" : "admin",
                        }),
                      );
                    }}
                  >
                    {account.server_role === "admin" ? "관리자 해제" : "관리자로 지정"}
                  </button>
                  <button
                    className={account.status === "active" ? "danger" : "quiet"}
                    disabled={busyId === account.account_id}
                    onClick={() => {
                      if (
                        account.status === "active" &&
                        !window.confirm(
                          `${account.username}을 비활성화하고 모든 로그인 세션을 종료할까요?`,
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
                    {account.status === "active" ? "비활성화" : "활성화"}
                  </button>
                </div>
              </article>
            ))}
            {visible.length === 0 && <p className="empty">조건에 맞는 계정이 없습니다.</p>}
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
      <Field label="사용자 ID" htmlFor="new-username">
        <input
          id="new-username"
          autoComplete="off"
          placeholder="alice"
          value={username}
          onChange={(event) => setUsername(event.target.value.toLowerCase())}
        />
      </Field>
      <Field label="초기 비밀번호" htmlFor="new-password">
        <input
          id="new-password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>
      <Field label="서버 권한" htmlFor="new-role">
        <select
          id="new-role"
          value={role}
          onChange={(event) => setRole(event.target.value as ServerRole)}
        >
          <option value="user">사용자</option>
          <option value="admin">관리자</option>
        </select>
      </Field>
      <button
        className="primary compact"
        disabled={busy || !username || characterCount(password) < 15}
      >
        {busy ? "추가하는 중…" : "계정 추가"}
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
        <p className="eyebrow">Credential reset</p>
        <h2 id="reset-title">{account.username} 비밀번호 재설정</h2>
        <p id="reset-detail">변경 즉시 이 계정의 모든 로그인 세션이 종료됩니다.</p>
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
          <Field label="새 비밀번호" htmlFor="reset-password">
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
              취소
            </button>
            <button className="primary" disabled={busy || characterCount(password) < 15}>
              재설정
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

function Notice({ children }: { children: React.ReactNode }) {
  return (
    <p className="notice" role="alert">
      {children}
    </p>
  );
}

function statusLabel(account: Account) {
  return account.status === "active" ? "활성" : "비활성";
}

function characterCount(value: string) {
  return Array.from(value).length;
}

function messageFor(cause: unknown): string {
  if (!(cause instanceof ApiError)) return "요청을 완료하지 못했습니다.";
  if (cause.status === 409) return "마지막 활성 관리자는 변경할 수 없습니다.";
  if (cause.status === 400) return cause.message || "입력값을 확인해 주세요.";
  if (cause.status === 401) return "관리자 세션이 만료되었습니다. 다시 로그인해 주세요.";
  return cause.message || "요청을 완료하지 못했습니다.";
}
