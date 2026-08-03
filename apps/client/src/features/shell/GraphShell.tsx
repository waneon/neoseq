import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import { CoreWorker } from "../../core-worker";
import { GraphSession } from "../../core-port/session";
import { graphName } from "../../core-port/directory";
import { isDeleted, pageKind, pageTitle } from "../../core-port/snapshot";
import { Callout } from "../../ui/components";
import { SessionContext } from "./session-context";
import { SaveStatus } from "./SaveStatus";

declare global {
  interface Window {
    __neoseqTest?: {
      injectStorageFault(fault: string): Promise<void>;
    };
  }
}

export function GraphShell() {
  const { graphId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [session, setSession] = useState<GraphSession | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    const worker = new CoreWorker();
    const created = new GraphSession(graphId, worker);
    setSession(created);
    void created.open();
    // Test-only hook used by the E2E storage-failure scenario; it reaches
    // the Worker's fault injection without exposing storage to the UI.
    window.__neoseqTest = {
      injectStorageFault: (fault: string) =>
        worker.injectFault(`local:${graphId}`, fault as never),
    };
    return () => {
      delete window.__neoseqTest;
      setSession(null);
      void created.close();
    };
  }, [graphId]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location]);

  if (!session) return <ShellFallback label="Opening graph…" />;
  return (
    <SessionContext.Provider value={session}>
      <ShellBody
        key={graphId}
        session={session}
        graphId={graphId}
        sidebarOpen={sidebarOpen}
        onToggleSidebar={() => setSidebarOpen((open) => !open)}
        onExit={() => navigate("/")}
      />
    </SessionContext.Provider>
  );
}

function ShellBody({
  session,
  graphId,
  sidebarOpen,
  onToggleSidebar,
  onExit,
}: {
  session: GraphSession;
  graphId: string;
  sidebarOpen: boolean;
  onToggleSidebar: () => void;
  onExit: () => void;
}) {
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  const navigate = useNavigate();
  const name = useMemo(() => graphName(graphId), [graphId]);

  // Shell-level undo/redo so the shortcuts survive focus loss (e.g. after an
  // undo removes the focused block). Text fields keep their own handling.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable
      ) {
        return;
      }
      const modifier = event.metaKey || event.ctrlKey;
      if (!modifier || event.key.toLowerCase() !== "z") return;
      event.preventDefault();
      void session.execute({ type: event.shiftKey ? "redo" : "undo" }).catch(() => undefined);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [session]);

  const pages = useMemo(
    () =>
      state.snapshot.pages
        .filter((page) => pageKind(page) === "regular" && !isDeleted(page))
        .sort((left, right) => pageTitle(left).localeCompare(pageTitle(right))),
    [state.snapshot],
  );

  if (state.status === "opening") return <ShellFallback label="Opening graph…" />;

  if (state.status === "error") {
    return (
      <main className="tombstone" data-testid="graph-error">
        <h1>This graph could not be opened</h1>
        <p>
          {state.error?.message ?? "Unknown error."} ({state.error?.code ?? "internal"})
        </p>
        <div className="actions">
          <Link className="btn btn-utility" to="/">
            Back to graphs
          </Link>
        </div>
      </main>
    );
  }

  const createPage = async () => {
    const pageId = `p-${crypto.randomUUID()}`;
    await session.execute({ type: "ensure_page", page_id: pageId, title: "Untitled" });
    navigate(`/g/${graphId}/p/${pageId}`);
  };

  return (
    <div className="shell">
      {sidebarOpen && (
        <button className="shell-scrim" aria-label="Close menu" onClick={onToggleSidebar} />
      )}
      <nav
        className="shell-sidebar"
        data-open={sidebarOpen}
        aria-label="Graph navigation"
        data-testid="sidebar"
      >
        <div className="shell-graph-name" title={name}>
          {name}
        </div>
        <div className="shell-nav">
          <NavLink className="shell-nav-item" to={`/g/${graphId}/journal`} end>
            <span aria-hidden>📆</span> Journal
          </NavLink>
          <NavLink className="shell-nav-item" to={`/g/${graphId}/settings`}>
            <span aria-hidden>⚙️</span> Settings
          </NavLink>
          <button className="shell-nav-item" onClick={onExit}>
            <span aria-hidden>🗂️</span> All graphs
          </button>
        </div>
        <div className="eyebrow shell-section-title">Pages</div>
        <div className="shell-nav" data-testid="page-list">
          {pages.map((page) => (
            <NavLink key={page.id} className="shell-nav-item" to={`/g/${graphId}/p/${page.id}`}>
              {pageTitle(page)}
            </NavLink>
          ))}
          <button className="shell-nav-item" onClick={() => void createPage()} data-testid="new-page">
            <span aria-hidden>＋</span> New page
          </button>
        </div>
      </nav>
      <div className="shell-main">
        <header className="shell-topbar">
          <button
            className="icon-btn shell-toggle"
            aria-label="Open menu"
            onClick={onToggleSidebar}
          >
            ☰
          </button>
          <button
            className="btn btn-ghost"
            aria-label="Undo"
            title="Undo (⌘Z)"
            disabled={state.mode === "readonly"}
            onClick={() => void session.execute({ type: "undo" }).catch(() => {})}
            data-testid="undo"
          >
            ↩ Undo
          </button>
          <button
            className="btn btn-ghost"
            aria-label="Redo"
            title="Redo (⇧⌘Z)"
            disabled={state.mode === "readonly"}
            onClick={() => void session.execute({ type: "redo" }).catch(() => {})}
            data-testid="redo"
          >
            ↪ Redo
          </button>
          <span className="spacer" />
          {state.mode === "readonly" && (
            <span className="status-pill" data-testid="readonly-pill">
              Read-only · open in another tab
            </span>
          )}
          <SaveStatus state={state} onRetry={() => void session.retry()} />
        </header>
        {state.recovery && state.recovery.quarantined_records.length > 0 && (
          <Callout tone="danger">
            {state.recovery.quarantined_records.length} damaged record(s) were quarantined during
            recovery. Intact data up to the last valid state was restored.
          </Callout>
        )}
        <div className="shell-content">
          <Outlet />
        </div>
      </div>
    </div>
  );
}

function ShellFallback({ label }: { label: string }) {
  return (
    <main className="tombstone" aria-busy="true">
      <h1>{label}</h1>
    </main>
  );
}
