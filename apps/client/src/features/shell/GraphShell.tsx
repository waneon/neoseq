import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import {
  CalendarDaysIcon,
  FileTextIcon,
  LibraryIcon,
  Loader2Icon,
  MenuIcon,
  PlusIcon,
  Redo2Icon,
  SettingsIcon,
  Undo2Icon,
} from "lucide-react";
import { CoreWorker } from "../../core-worker";
import { GraphSession } from "../../core-port/session";
import { graphName } from "../../core-port/directory";
import { isDeleted, pageKind, pageTitle } from "../../core-port/snapshot";
import { Callout } from "../../ui/components";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/shadcn/tooltip";
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

  if (!session) return <ShellLoading />;
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

  // A calm, delayed loader (rather than a full-bleed card) prevents the
  // sub-frame "Opening graph…" flash on fast local opens.
  if (state.status === "opening") return <ShellLoading />;

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
            <CalendarDaysIcon aria-hidden strokeWidth={2.25} /> Journal
          </NavLink>
          <NavLink className="shell-nav-item" to={`/g/${graphId}/settings`}>
            <SettingsIcon aria-hidden strokeWidth={2.25} /> Settings
          </NavLink>
          <button className="shell-nav-item" onClick={onExit}>
            <LibraryIcon aria-hidden strokeWidth={2.25} /> All graphs
          </button>
        </div>
        <div className="eyebrow shell-section-title">Pages</div>
        <div className="shell-nav" data-testid="page-list">
          {pages.map((page) => (
            <NavLink key={page.id} className="shell-nav-item" to={`/g/${graphId}/p/${page.id}`}>
              <FileTextIcon aria-hidden strokeWidth={2.25} />
              <span className="nav-label">{pageTitle(page)}</span>
            </NavLink>
          ))}
          <button
            className="shell-nav-item shell-nav-muted"
            onClick={() => void createPage()}
            data-testid="new-page"
          >
            <PlusIcon aria-hidden strokeWidth={2.25} /> New page
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
            <MenuIcon />
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="btn btn-ghost"
                aria-label="Undo"
                disabled={state.mode === "readonly"}
                onClick={() => void session.execute({ type: "undo" }).catch(() => {})}
                data-testid="undo"
              >
                <Undo2Icon aria-hidden /> Undo
              </button>
            </TooltipTrigger>
            <TooltipContent>Undo · ⌘Z</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                className="btn btn-ghost"
                aria-label="Redo"
                disabled={state.mode === "readonly"}
                onClick={() => void session.execute({ type: "redo" }).catch(() => {})}
                data-testid="redo"
              >
                <Redo2Icon aria-hidden /> Redo
              </button>
            </TooltipTrigger>
            <TooltipContent>Redo · ⇧⌘Z</TooltipContent>
          </Tooltip>
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
        <div className="shell-content enter-fade" key={graphId}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}

/**
 * A flicker-free loading state: renders nothing for a short grace period, then
 * fades in a quiet spinner only if the open is genuinely slow. Fast local
 * opens (the common case) show no loading screen at all.
 */
function ShellLoading() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), 220);
    return () => clearTimeout(timer);
  }, []);

  if (!show) return <main className="shell-loading" aria-busy="true" aria-hidden />;
  return (
    <main className="shell-loading" role="status" aria-busy="true">
      <Loader2Icon className="spinner" aria-hidden />
      <p>Opening graph…</p>
    </main>
  );
}
