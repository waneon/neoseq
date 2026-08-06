import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import {
  CalendarDaysIcon,
  BugIcon,
  ChevronsUpDownIcon,
  FileTextIcon,
  InfoIcon,
  KeyboardIcon,
  LayoutGridIcon,
  Loader2Icon,
  MoonIcon,
  MoreHorizontalIcon,
  PanelLeftIcon,
  PlusIcon,
  Redo2Icon,
  SearchIcon,
  Settings2Icon,
  SettingsIcon,
  Trash2Icon,
  Undo2Icon,
} from "lucide-react";
import {
  clearTestHook,
  createCoreWorker,
  injectStorageFault,
} from "virtual:neoseq-worker-factory";
import { GraphSession } from "../../core-port/session";
import { graphName, renameGraph, subscribeGraphDirectory } from "../../core-port/directory";
import {
  findJournalPage,
  isDeleted,
  pageKind,
  pageTitle,
  type PageSnapshot,
} from "../../core-port/snapshot";
import { Wordmark } from "../../ui/brand";
import { Kbd } from "@/ui/kbd";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/ui/shadcn/tooltip";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { nextTheme, setTheme, storedTheme, type Theme } from "../../ui/theme";
import { addDays, todayLocalDate } from "../../entities/journal";
import { canonicalEntityName, nextAvailableEntityName } from "../../entities/names";
import {
  CommandContext,
  useCommands,
  type CommandBridge,
  type PageActions,
} from "../commands/context";
import { CommandPalette } from "../commands/CommandPalette";
import { Shortcut } from "../commands/Shortcut";
import { ShortcutSheet } from "../commands/ShortcutSheet";
import { parseDateQuery } from "../commands/dates";
import { isTextEntry } from "../commands/keys";
import {
  formatBinding,
  formatBindingParts,
  bindingMatches,
  matchShortcut,
  useShortcutBindings,
  type Binding,
  type ShortcutHandler,
  type ShortcutId,
} from "../commands/shortcuts";
import { useNotify, type Notifier } from "../notify/context";
import type { RdfTerm } from "../../generated/core-port";
import type { Command } from "../commands/registry";
import {
  SettingsDialog,
  isSettingsSection,
  type SettingsSection,
} from "../settings/SettingsDialog";
import { SessionContext } from "./session-context";
import { SaveStatus } from "./SaveStatus";
import { useI18n, type MessageFunction } from "../../i18n";
import { useDiagnostics, useDiagnosticsState } from "../diagnostics/context";
import { RecordingStatus } from "../diagnostics/RecordingStatus";
import type { DiagnosticsPhase } from "../../diagnostics/types";

declare global {
  interface Window {
    __neoseqTest?: {
      injectStorageFault(fault: string): Promise<void>;
    };
  }
}

const RAIL_KEY = "neoseq.rail";
const SETTINGS_PARAM = "settings";

export function GraphShell() {
  const { graphId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [session, setSession] = useState<GraphSession | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let created: GraphSession | undefined;
    void (async () => {
      const worker = createCoreWorker();
      if (cancelled) {
        worker.terminate();
        return;
      }
      created = new GraphSession(graphId, worker);
      setSession(created);
      void created.open();
      const faultInjector = injectStorageFault;
      if (faultInjector) {
        window.__neoseqTest = {
          injectStorageFault: (fault: string) =>
            faultInjector(worker, `local:${graphId}`, fault),
        };
      }
    })();
    return () => {
      cancelled = true;
      clearTestHook();
      setSession(null);
      void created?.close();
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
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const notify = useNotify();
  const { message, locale, formatJournalDate, compare } = useI18n();
  const bindings = useShortcutBindings();
  const diagnostics = useDiagnostics();
  const diagnosticsState = useDiagnosticsState();
  // Renaming happens in the settings dialog, which sits over this rail; both have
  // to say the same thing while they are on screen together.
  const name = useSyncExternalStore(
    subscribeGraphDirectory,
    () => graphName(graphId),
    () => graphName(graphId),
  );
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [theme, setThemeState] = useState<Theme>(storedTheme);
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === "collapsed";
    } catch {
      return false;
    }
  });
  const [scrolled, setScrolled] = useState(false);
  const blockProperties = useRef<(() => void) | null>(null);
  const pageProperties = useRef<(() => void) | null>(null);
  const pageActions = useRef<PageActions | null>(null);
  const readonlyAnnounced = useRef(false);
  const recoveryAnnounced = useRef(false);

  const readonly = state.mode === "readonly";

  // The open settings section lives in the URL, so the browser's own Back closes
  // the dialog and a link can point straight at one section.
  const settingsParam = searchParams.get(SETTINGS_PARAM);
  const settingsSection = isSettingsSection(settingsParam) ? settingsParam : null;

  const openSettings = useCallback(
    (section: SettingsSection = "appearance") => {
      const next = new URLSearchParams(searchParams);
      const wasOpen = next.has(SETTINGS_PARAM);
      next.set(SETTINGS_PARAM, section);
      // Opening pushes, so Back closes the dialog. Moving between its sections
      // replaces, so Back does not have to walk back out through every section
      // the user glanced at on the way.
      setSearchParams(next, wasOpen ? { replace: true } : undefined);
    },
    [searchParams, setSearchParams],
  );

  const closeSettings = useCallback(() => {
    const next = new URLSearchParams(searchParams);
    next.delete(SETTINGS_PARAM);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);

  const pages = useMemo(
    () =>
      state.snapshot.pages
        .filter((page) => pageKind(page) === "regular" && !isDeleted(page))
        .sort((left, right) => compare(pageTitle(left), pageTitle(right))),
    [compare, state.snapshot],
  );

  const createPage = useCallback(
    async (title?: string) => {
      const pageId = `p-${crypto.randomUUID()}`;
      const pageName = title ?? nextAvailableEntityName(message("page.untitled"), pages.map(pageTitle));
      try {
        await session.execute({ type: "ensure_page", page_id: pageId, title: pageName });
      } catch (error) {
        notify.failure(message("failure.createPage", { name: pageName }), error);
        return;
      }
      navigate(`/g/${graphId}/p/${pageId}`);
    },
    [graphId, message, navigate, notify, pages, session],
  );

  const toggleRail = useCallback(() => {
    setRailCollapsed((collapsed) => {
      const next = !collapsed;
      try {
        localStorage.setItem(RAIL_KEY, next ? "collapsed" : "expanded");
      } catch {
        // Persistence is a nicety; the current session still honours the choice.
      }
      return next;
    });
  }, []);

  const bridge = useMemo<CommandBridge>(
    () => ({
      openPalette: () => setPaletteOpen(true),
      openShortcuts: () => setShortcutsOpen(true),
      openSettings,
      setBlockProperties: (handler) => {
        blockProperties.current = handler;
      },
      setPageProperties: (handler) => {
        pageProperties.current = handler;
      },
      setPageActions: (actions) => {
        pageActions.current = actions;
      },
      requestProperties: () => {
        const handler = blockProperties.current ?? pageProperties.current;
        if (!handler) return false;
        handler();
        return true;
      },
      requestPageInfo: () => pageActions.current?.info(),
      requestPageDelete: () => pageActions.current?.remove(),
    }),
    [openSettings],
  );

  const applyTheme = useCallback((next: Theme) => {
    setTheme(next);
    setThemeState(next);
  }, []);

  // One listener, one arbitration order — and one more rule than before: a modal
  // surface owns the keyboard while it is up. Opening the palette over a
  // focus-trapping dialog would leave the palette's own input unable to keep
  // focus, so the global layer stands down instead of racing it.
  const overlayOpen = settingsSection !== null || shortcutsOpen;
  useEffect(() => {
    const undo = (redo: boolean) => void runHistory(session, notify, message, redo);
    const handlers: ShortcutHandler[] = [
      { binding: bindings.palette, run: () => setPaletteOpen(true) },
      { binding: bindings.shortcuts, run: () => setShortcutsOpen(true) },
      { binding: bindings.sidebar, run: toggleRail },
      { binding: bindings.settings, run: () => openSettings() },
    ];
    const onKeyDown = (event: KeyboardEvent) => {
      if (overlayOpen) {
        // The one binding that still answers while Settings is up: pressing it
        // again shuts the thing it opened, which is what a toggle owes the user.
        if (settingsSection) {
          const closing = matchShortcut(event, [
            { binding: bindings.settings, run: closeSettings },
          ]);
          if (closing) {
            event.preventDefault();
            closing.run(event);
          }
        }
        return;
      }
      // Printing is the browser's established Mod+P action. We only claim the
      // chord when the current page or focused block has a real property target.
      if (bindingMatches(event, bindings.properties)) {
        if (bridge.requestProperties()) event.preventDefault();
        return;
      }
      const handler = matchShortcut(event, handlers);
      if (handler) {
        event.preventDefault();
        handler.run(event);
        return;
      }
      // Undo/redo stay outside text fields: inside one, the platform's own text
      // undo is what a user editing a page title or a property value expects.
      // The outline's textarea is the exception and handles the document undo
      // itself, because there its text edits *are* the document.
      if (isTextEntry(event.target)) return;
      const history = matchShortcut(event, [
        { binding: bindings.undo, run: () => undo(false) },
        { binding: bindings.redo, run: () => undo(true) },
      ]);
      if (history) {
        event.preventDefault();
        history.run(event);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [
    bindings,
    bridge,
    closeSettings,
    message,
    notify,
    openSettings,
    overlayOpen,
    session,
    settingsSection,
    toggleRail,
  ]);

  // Read-only is a state a second tab lands in without asking for it, and the
  // 12px label beside the save slot is easy to miss when the first thing you do
  // is start typing. Say it once, plainly — the permanent label in the top bar is
  // what carries the condition after the report has expired. Once really means
  // once: a remount must not reopen a notice the user already closed.
  useEffect(() => {
    if (!readonly || readonlyAnnounced.current) return;
    readonlyAnnounced.current = true;
    notify.show({
      tone: "info",
      key: "readonly-lease",
      duration: 12000,
      title: message("shell.readonlyTitle"),
      detail: message("shell.readonlyDetail"),
    });
  }, [message, notify, readonly]);

  // Quarantined records are a fact about data the user cannot see from here, so
  // they are reported once rather than pinned above the writing surface. The
  // durable copy lives in Settings → This graph, which the report names.
  useEffect(() => {
    const quarantined = state.recovery?.quarantined_records.length ?? 0;
    if (quarantined === 0 || recoveryAnnounced.current) return;
    recoveryAnnounced.current = true;
    notify.show({
      tone: "danger",
      key: "quarantined-records",
      title: message("shell.recoveryTitle"),
      detail: message("shell.recovery", { count: quarantined }),
      action: {
        label: message("settings.title"),
        run: () => openSettings("graph"),
      },
    });
  }, [message, notify, openSettings, state.recovery]);

  // The top bar earns its bottom edge and its condensed title only once the
  // content beneath has actually moved. `scroll` does not bubble, but it still
  // reaches a capture-phase listener, so this needs no reference to the scroll
  // container the routed view owns — and no assumption about when it mounts.
  useEffect(() => {
    const read = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.classList.contains("page-scroll")) {
        return;
      }
      setScrolled(target.scrollTop > 56);
    };
    window.addEventListener("scroll", read, true);
    return () => window.removeEventListener("scroll", read, true);
  }, []);

  useEffect(() => {
    setScrolled(false);
  }, [location.pathname]);

  useEffect(() => {
    const path = location.pathname;
    diagnostics.recordRoute(
      settingsSection
        ? "settings"
        : path.includes("/journal")
          ? "journal"
          : path.includes("/p/")
            ? "page"
            : "other",
    );
  }, [diagnostics, location.pathname, settingsSection]);

  const today = todayLocalDate();
  const journalMatch = /\/journal(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(location.pathname);
  const currentDate = journalMatch ? (journalMatch[1] ?? today) : null;
  const currentPage = /\/p\/([^/]+)$/.exec(location.pathname)?.[1];
  const diagnosticPageId = currentPage ?? (
    currentDate ? findJournalPage(state.snapshot, currentDate)?.id : undefined
  );

  useEffect(
    () => diagnostics.registerGraphContext({
      graph_id: graphId,
      active_page_id: diagnosticPageId ?? null,
      read: () => {
        const current = session.getState();
        return { snapshot: current.snapshot, revision: current.revision };
      },
    }),
    [diagnosticPageId, graphId, session],
  );

  // Query-dependent rows: a date the user typed, and — when nothing matches — a
  // page to create, so the list is never a dead end.
  const dynamic = useCallback(
    (query: string): Command[] => {
      if (query.length === 0) return [];
      const rows: Command[] = [];
      const date = parseDateQuery(query, today, locale);
      if (date) {
        rows.push({
          id: `journal-${date}`,
          group: "Journal",
          label: formatJournalDate(date),
          hint: date === today ? message("commands.hintToday") : message("commands.hintJournal"),
          icon: <CalendarDaysIcon aria-hidden />,
          pointerRoute: message("shortcuts.nextPrevDayRoute"),
          run: () => navigate(`/g/${graphId}/journal/${date}`),
        });
      }
      const exists = pages.some(
        (page) => canonicalEntityName(pageTitle(page)) === canonicalEntityName(query),
      );
      if (!date && !exists && !readonly) {
        rows.push({
          id: "create-page",
          group: "Pages",
          label: message("commands.createPage", { title: query }),
          icon: <PlusIcon aria-hidden />,
          pointerRoute: message("shortcuts.newPageRoute"),
          run: () => createPage(query),
        });
      }
      return rows;
    },
    [createPage, formatJournalDate, graphId, locale, message, navigate, pages, readonly, today],
  );

  const searchGraph = useCallback(
    async (needle: string): Promise<Command[]> => {
      const result = await session.query({
        language: "sparql-1.1/neoseq-v1",
        source: `PREFIX neo: <urn:neoseq:vocab:v1:>
SELECT ?entity ?content ?page WHERE {
  { ?entity a neo:Page; neo:content ?content. BIND(?entity AS ?page) }
  UNION
  { ?entity a neo:Block; neo:content ?content; neo:page ?page. }
  FILTER(neo:matchesText(?content, ?needle))
} ORDER BY ?content LIMIT 20`,
        bindings: {
          needle: {
            kind: "literal",
            value: needle,
            datatype: "http://www.w3.org/2001/XMLSchema#string",
          },
        },
      });
      if (result.kind !== "select") return [];
      return result.rows.flatMap((row, index) => {
        const entity = row.entity;
        const page = row.page;
        const content = literalText(row.content);
        const pageId = page?.kind === "iri" && page.entity?.kind === "page"
          ? page.entity.id
          : null;
        if (!pageId || entity?.kind !== "iri" || !entity.entity) return [];
        const isBlock = entity.entity.kind === "block";
        return [{
          id: `search-${index}-${entity.value}`,
          group: "Search" as const,
          label: content || (isBlock ? entity.entity.id : pageId),
          hint: isBlock ? message("commands.blockHint") : message("commands.hintPage"),
          icon: <SearchIcon aria-hidden />,
          pointerRoute: message("shell.search"),
          run: () => navigate(`/g/${graphId}/p/${pageId}`),
        }];
      });
    },
    [graphId, message, navigate, session],
  );

  // A calm, delayed loader (rather than a full-bleed card) prevents the
  // sub-frame "Opening graph…" flash on fast local opens.
  if (state.status === "opening") return <ShellLoading />;

  if (state.status === "error") {
    return (
      <main className="picker">
        <div className="picker-recording-status">
          <RecordingStatus />
        </div>
        <div className="picker-inner">
          <div className="tombstone" data-testid="graph-error">
            <h1>{message("graph.loadError")}</h1>
            <p>{message("error.internal")}</p>
            <div className="actions">
              <Link className="btn" to="/">
                {message("graph.backToGraphs")}
              </Link>
            </div>
          </div>
        </div>
      </main>
    );
  }

  const contextTitle = currentDate
    ? formatJournalDate(currentDate)
    : currentPage
      ? (pages.find((page) => page.id === currentPage)
          ? pageTitle(pages.find((page) => page.id === currentPage)!)
          : message("common.page"))
      : name;

  const commands = buildCommands({
    pages,
    graphId,
    today,
    currentDate,
    readonly,
    theme,
    navigate,
    createPage,
    onExit,
    session,
    notify,
    bridge,
    toggleRail,
    railCollapsed,
    applyTheme,
    message,
    formatJournalDate,
    bindings,
    diagnosticsPhase: diagnosticsState.phase,
    requestDiagnostics: () => diagnostics.requestStart(),
    stopDiagnostics: () => void diagnostics.stop(),
    reviewDiagnostics: () => diagnostics.showReview(),
  });

  return (
    <CommandContext.Provider value={bridge}>
      <div className="shell" data-rail={railCollapsed ? "collapsed" : "expanded"}>
        <a className="skip-link" href="#page-content">
          {message("shell.skipContent")}
        </a>
        {sidebarOpen && (
          <button
            className="shell-scrim"
            aria-label={message("shell.closeMenu")}
            onClick={onToggleSidebar}
          />
        )}
        <nav
          className="shell-sidebar"
          data-open={sidebarOpen}
          aria-label={message("shell.graphNavigation")}
          data-testid="sidebar"
        >
          <p className="rail-brand" data-testid="brand">
            <Wordmark name={message("app.title")} />
          </p>
          <GraphSwitcher graphId={graphId} name={name} onExit={onExit} />
          <div className="shell-nav">
            {/* Search is the affordance that licenses how bare the rest of the
                interface is, so it stays permanent — it just belongs beside the
                other places you can go rather than in the writing surface's
                own top bar. */}
            <button
              className="shell-nav-item"
              onClick={() => setPaletteOpen(true)}
              aria-label={message("commands.searchLabel")}
              aria-keyshortcuts={formatBinding(bindings.palette)}
              data-testid="open-palette"
            >
              <SearchIcon aria-hidden />
              <span className="nav-label">{message("shell.search")}</span>
              <Shortcut binding={bindings.palette} className="nav-kbd" />
            </button>
            <NavLink className="shell-nav-item" to={`/g/${graphId}/journal`} end>
              <CalendarDaysIcon aria-hidden />
              <span className="nav-label">{message("shell.journal")}</span>
            </NavLink>
          </div>
          <div className="rail-group">
            <h2>{message("shell.pages")}</h2>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="icon-btn"
                  aria-label={message("shell.newPage")}
                  onClick={() => void createPage()}
                  data-testid="new-page"
                >
                  <PlusIcon aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent>{message("shell.newPage")}</TooltipContent>
            </Tooltip>
          </div>
          <div className="shell-nav" data-testid="page-list">
            {pages.length === 0 && <p className="rail-note">{message("shell.noPages")}</p>}
            {pages.map((page) => (
              <NavLink key={page.id} className="shell-nav-item" to={`/g/${graphId}/p/${page.id}`}>
                <FileTextIcon aria-hidden />
                <span className="nav-label">{pageTitle(page)}</span>
              </NavLink>
            ))}
          </div>
          <div className="rail-spacer" />
          <div className="rail-footer">
            {/* One footer row. "All graphs" used to sit here as well, saying the
                same thing as the graph switcher's own last item. */}
            <button
              className="shell-nav-item"
              onClick={() => openSettings()}
              aria-keyshortcuts={formatBinding(bindings.settings)}
              data-testid="open-settings"
            >
              <SettingsIcon aria-hidden />
              <span className="nav-label">{message("shell.settings")}</span>
            </button>
          </div>
        </nav>
        <main className="shell-main">
          <header className="shell-topbar" data-scrolled={scrolled}>
            <button
              className="icon-btn shell-toggle"
              aria-label={sidebarOpen ? message("shell.closeMenu") : message("shell.openMenu")}
              aria-expanded={sidebarOpen}
              onClick={onToggleSidebar}
            >
              <PanelLeftIcon />
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="icon-btn rail-toggle"
                  aria-label={message("shell.showSidebar")}
                  aria-keyshortcuts={formatBinding(bindings.sidebar)}
                  onClick={toggleRail}
                >
                  <PanelLeftIcon />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {message("shell.showSidebar")} · {formatBinding(bindings.sidebar)}
              </TooltipContent>
            </Tooltip>
            <span className="topbar-title" aria-hidden>
              {contextTitle}
            </span>
            {/* State, then the one verb. Durability, the read-only lease and
                active diagnostic recording each render nothing when there is
                nothing to say; the overflow menu is always the last thing on the
                bar, which is where every application this one resembles puts
                "everything else". */}
            <div className="topbar-right">
              <RecordingStatus />
              <SaveStatus state={state} onRetry={() => void session.retry()} />
              {readonly && (
                <span className="readonly-label" data-testid="readonly-pill">
                  {message("shell.readonly")}
                </span>
              )}
              <OverflowMenu
                commands={commands}
                onOpenPalette={() => setPaletteOpen(true)}
                bindings={bindings}
              />
            </div>
          </header>
          <div className="shell-content" id="page-content">
            <Outlet />
          </div>
        </main>
      </div>
      {paletteOpen && (
        <CommandPalette
          commands={commands}
          dynamic={dynamic}
          search={searchGraph}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {shortcutsOpen && <ShortcutSheet onClose={() => setShortcutsOpen(false)} />}
      {settingsSection && (
        <SettingsDialog
          graphId={graphId}
          section={settingsSection}
          onSection={openSettings}
          onClose={closeSettings}
        />
      )}
    </CommandContext.Provider>
  );
}

function literalText(term: RdfTerm | undefined): string {
  return term?.kind === "literal" ? term.value : "";
}

/**
 * The top bar's `⋯`, and what it lists.
 *
 * DESIGN.md § Disclosure says the top bar holds no verbs, and it still does not:
 * a menu is summoned, and everything inside this one is also a palette row and,
 * where it has one, a key. What it adds is the affordance the bare interface was
 * missing — a single, conventional, always-there place a user who has learned no
 * shortcut and does not know a palette exists can look for "what else can this do".
 * `⌘K` licensed the emptiness for people who already knew about `⌘K`.
 *
 * It is generated from the command registry rather than hand-listed, so it cannot
 * drift from what the application actually does: every row's label, icon, keyboard
 * badge and disabled reason is the one the palette shows for the same verb, and a
 * verb that stops existing stops appearing here. `null` is a separator.
 */
const OVERFLOW_ROWS: readonly (string | null)[] = [
  "properties",
  "shortcuts",
  null,
  "undo",
  "redo",
  null,
  "theme",
  "toggle-rail",
  "diagnostics",
  null,
  "settings",
  "all-graphs",
];

function OverflowMenu({
  commands,
  bindings,
  onOpenPalette,
}: {
  commands: Command[];
  bindings: Record<ShortcutId, Binding>;
  onOpenPalette: () => void;
}) {
  const { message } = useI18n();
  const byId = new Map(commands.map((command) => [command.id, command]));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          className="icon-btn"
          aria-label={message("shell.moreActions")}
          data-testid="overflow-menu"
        >
          <MoreHorizontalIcon aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {/* Search leads, because it is what the rest of the menu is an overflow
            of, and it is the only row whose verb the shell owns directly. */}
        <DropdownMenuItem onSelect={onOpenPalette} data-testid="overflow-search">
          <SearchIcon aria-hidden />
          {message("shell.search")}
          <DropdownMenuShortcut>
            <Shortcut binding={bindings.palette} plain />
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        {OVERFLOW_ROWS.map((id, index) => {
          if (id === null) return <DropdownMenuSeparator key={`separator-${index}`} />;
          const command = byId.get(id);
          if (!command) return null;
          return (
            <DropdownMenuItem
              key={id}
              // Listed with its reason rather than hidden, exactly as in the
              // palette: a read-only graph should say why Undo is unavailable.
              disabled={Boolean(command.disabledReason)}
              onSelect={() => void command.run()}
              data-testid={`overflow-${id}`}
            >
              {command.icon}
              {command.label}
              {command.binding && (
                <DropdownMenuShortcut>
                  <Kbd parts={command.binding} plain />
                </DropdownMenuShortcut>
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function GraphSwitcher({
  graphId,
  name,
  onExit,
}: {
  graphId: string;
  name: string;
  onExit: () => void;
}) {
  const { message } = useI18n();
  const bridge = useCommands();
  const bindings = useShortcutBindings();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(name);

  if (renaming) {
    return (
      <form
        className="px-1 py-0.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (draft.trim()) renameGraph(graphId, draft.trim());
          setRenaming(false);
        }}
      >
        <input
          className="h-8 w-full rounded-md bg-[var(--canvas)] px-2 text-sm shadow-[var(--e1)]"
          aria-label={message("graph.graphName")}
          autoFocus
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            if (draft.trim()) renameGraph(graphId, draft.trim());
            setRenaming(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(name);
              setRenaming(false);
            }
          }}
        />
      </form>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button className="rail-switcher" data-testid="graph-switcher">
          <span className="name">{name}</span>
          <ChevronsUpDownIcon aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem
          onSelect={() => {
            setDraft(name);
            setRenaming(true);
          }}
        >
          {message("graph.rename")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => bridge.openSettings("graph")}>
          {message("graph.settings")}
          <DropdownMenuShortcut>
            <Shortcut binding={bindings.settings} plain />
          </DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onExit}>{message("graph.allGraphs")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface CommandInputs {
  pages: PageSnapshot[];
  graphId: string;
  today: string;
  currentDate: string | null;
  readonly: boolean;
  theme: Theme;
  railCollapsed: boolean;
  navigate: (to: string) => void;
  createPage: (title?: string) => Promise<void>;
  onExit: () => void;
  session: GraphSession;
  notify: Notifier;
  bridge: CommandBridge;
  toggleRail: () => void;
  applyTheme: (next: Theme) => void;
  message: MessageFunction;
  formatJournalDate: (date: string) => string;
  bindings: Record<ShortcutId, Binding>;
  diagnosticsPhase: DiagnosticsPhase;
  requestDiagnostics: () => void;
  stopDiagnostics: () => void;
  reviewDiagnostics: () => void;
}

/**
 * Undo and redo are the two verbs the interface offers with no visible result
 * of their own when they fail: the graph simply does not move. Reporting is the
 * only thing that separates "there was nothing to undo" from "the command was
 * rejected", so neither path is allowed to swallow its error.
 */
function runHistory(
  session: GraphSession,
  notify: Notifier,
  message: MessageFunction,
  redo: boolean,
): Promise<void> {
  return session
    .execute({ type: redo ? "redo" : "undo" })
    .then(() => undefined)
    .catch((error: unknown) => {
      notify.failure(redo ? message("failure.redo") : message("failure.undo"), error);
    });
}

const THEME_MESSAGE = {
  system: "theme.system",
  light: "theme.light",
  dark: "theme.dark",
} as const;

/**
 * Builds the palette's contents. Navigation comes first because that is what a
 * palette is opened for, and every action carries the pointer route that makes
 * removing its button safe.
 */
function buildCommands(input: CommandInputs): Command[] {
  const {
    pages,
    graphId,
    today,
    currentDate,
    readonly,
    theme,
    navigate,
    createPage,
    onExit,
    session,
    notify,
    bridge,
    toggleRail,
    railCollapsed,
    applyTheme,
    message,
    formatJournalDate,
    bindings,
    diagnosticsPhase,
    requestDiagnostics,
    stopDiagnostics,
    reviewDiagnostics,
  } = input;
  const blocked = readonly ? message("commands.readonlyReason") : null;
  const commands: Command[] = [];

  for (const page of pages) {
    const title = pageTitle(page);
    commands.push({
      id: `page-${page.id}`,
      group: "Pages",
      label: title,
      keywords: ["open page", "go to"],
      hint: message("commands.hintPage"),
      icon: <FileTextIcon aria-hidden />,
      pointerRoute: message("shell.pages"),
      run: () => navigate(`/g/${graphId}/p/${page.id}`),
    });
  }

  commands.push({
    id: "new-page",
    group: "Pages",
    label: message("commands.label.newPage"),
    keywords: ["create", "add page"],
    icon: <PlusIcon aria-hidden />,
    disabledReason: blocked,
    pointerRoute: message("shortcuts.newPageRoute"),
    run: () => void createPage(),
  });

  // The page's own verbs. Their pointer route is a right-click on the title;
  // these rows are what keeps them reachable from the keyboard as well.
  commands.push(
    {
      id: "page-info",
      group: "Pages",
      label: message("commands.label.pageInfo"),
      keywords: ["details", "created", "updated"],
      icon: <InfoIcon aria-hidden />,
      pointerRoute: message("shortcuts.pageDetailsRoute"),
      run: () => bridge.requestPageInfo(),
    },
    {
      id: "delete-page",
      group: "Pages",
      label: message("commands.label.deletePage"),
      keywords: ["remove page", "trash"],
      icon: <Trash2Icon aria-hidden />,
      disabledReason: blocked,
      pointerRoute: message("shortcuts.deletePageRoute"),
      run: () => bridge.requestPageDelete(),
    },
  );

  commands.push({
    id: "journal-today",
    group: "Journal",
    label: message("commands.label.todayJournal"),
    keywords: ["today", "journal", "daily"],
    hint: formatJournalDate(today),
    icon: <CalendarDaysIcon aria-hidden />,
    pointerRoute: message("shell.journal"),
    run: () => navigate(`/g/${graphId}/journal`),
  });

  if (currentDate) {
    commands.push(
      {
        id: "journal-prev",
        group: "Journal",
        label: message("commands.label.previousDay"),
        icon: <CalendarDaysIcon aria-hidden />,
        pointerRoute: message("shortcuts.nextPrevDayRoute"),
        run: () => navigate(`/g/${graphId}/journal/${addDays(currentDate, -1)}`),
      },
      {
        id: "journal-next",
        group: "Journal",
        label: message("commands.label.nextDay"),
        icon: <CalendarDaysIcon aria-hidden />,
        pointerRoute: message("shortcuts.nextPrevDayRoute"),
        run: () => navigate(`/g/${graphId}/journal/${addDays(currentDate, 1)}`),
      },
    );
  }

  commands.push({
    id: "properties",
    group: "Block",
    label: message("commands.label.properties"),
    keywords: ["property", "tag", "metadata"],
    binding: formatBindingParts(bindings.properties),
    hint: message("commands.pagePropertiesHint"),
    icon: <Settings2Icon aria-hidden />,
    pointerRoute: message("shortcuts.blockActionsRoute"),
    run: () => {
      bridge.requestProperties();
    },
  });

  commands.push(
    {
      id: "undo",
      group: "Edit",
      label: message("commands.label.undo"),
      binding: formatBindingParts(bindings.undo),
      icon: <Undo2Icon aria-hidden />,
      disabledReason: blocked,
      pointerRoute: message("commands.paletteRoute"),
      run: () => void runHistory(session, notify, message, false),
    },
    {
      id: "redo",
      group: "Edit",
      label: message("commands.label.redo"),
      binding: formatBindingParts(bindings.redo),
      icon: <Redo2Icon aria-hidden />,
      disabledReason: blocked,
      pointerRoute: message("commands.paletteRoute"),
      run: () => void runHistory(session, notify, message, true),
    },
  );

  commands.push(
    {
      id: "settings",
      group: "Graph",
      label: message("commands.label.settings"),
      binding: formatBindingParts(bindings.settings),
      icon: <SettingsIcon aria-hidden />,
      pointerRoute: message("shell.settings"),
      run: () => bridge.openSettings(),
    },
    {
      id: "all-graphs",
      group: "Graph",
      label: message("commands.label.allGraphs"),
      keywords: ["switch graph", "close graph"],
      icon: <LayoutGridIcon aria-hidden />,
      pointerRoute: message("shortcuts.switchGraphRoute"),
      run: onExit,
    },
  );

  commands.push(
    {
      id: "theme",
      group: "App",
      label: message("commands.appearance", { theme: message(THEME_MESSAGE[theme]) }),
      keywords: ["dark mode", "light mode", "theme"],
      hint: message("commands.appearanceHint", {
        theme: message(THEME_MESSAGE[nextTheme(theme)]),
      }),
      icon: <MoonIcon aria-hidden />,
      pointerRoute: message("settings.appearance"),
      run: () => applyTheme(nextTheme(theme)),
    },
    {
      id: "toggle-rail",
      group: "App",
      label: railCollapsed
        ? message("commands.label.showSidebar")
        : message("commands.label.hideSidebar"),
      binding: formatBindingParts(bindings.sidebar),
      icon: <PanelLeftIcon aria-hidden />,
      pointerRoute: message("shell.showSidebar"),
      run: toggleRail,
    },
    {
      id: "shortcuts",
      group: "App",
      label: message("commands.label.keyboardShortcuts"),
      binding: formatBindingParts(bindings.shortcuts),
      icon: <KeyboardIcon aria-hidden />,
      pointerRoute: message("shortcuts.customiseRoute"),
      run: () => bridge.openShortcuts(),
    },
    {
      id: "diagnostics",
      group: "App",
      label: diagnosticsPhase === "recording"
        ? message("diagnostics.stopAndReview")
        : diagnosticsPhase === "review"
          ? message("diagnostics.review")
          : message("diagnostics.start"),
      keywords: ["bug", "performance", "trace", "report"],
      icon: <BugIcon aria-hidden />,
      disabledReason: diagnosticsPhase === "consent" || diagnosticsPhase === "finalizing"
        ? message("diagnostics.preparing")
        : null,
      pointerRoute: message("diagnostics.pointerRoute"),
      run: diagnosticsPhase === "recording"
        ? stopDiagnostics
        : diagnosticsPhase === "review"
          ? reviewDiagnostics
          : requestDiagnostics,
    },
  );

  return commands;
}

/**
 * A flicker-free loading state: renders nothing for a short grace period, then
 * fades in a quiet spinner only if the open is genuinely slow. Fast local
 * opens (the common case) show no loading screen at all.
 */
function ShellLoading() {
  const { message } = useI18n();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), 220);
    return () => clearTimeout(timer);
  }, []);

  return (
    <>
      <div className="picker-recording-status">
        <RecordingStatus />
      </div>
      <div className="shell-loading" role="status" aria-busy="true">
        {show && (
          <>
          <Loader2Icon className="spinner" aria-hidden />
          <p>{message("graph.loading")}</p>
          </>
        )}
      </div>
    </>
  );
}
