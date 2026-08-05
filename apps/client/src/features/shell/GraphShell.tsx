import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import {
  CalendarDaysIcon,
  ChevronsUpDownIcon,
  FileTextIcon,
  KeyboardIcon,
  LayoutGridIcon,
  Loader2Icon,
  MoonIcon,
  PanelLeftIcon,
  PlusIcon,
  Redo2Icon,
  SearchIcon,
  Settings2Icon,
  SettingsIcon,
  Undo2Icon,
} from "lucide-react";
import {
  clearTestHook,
  createCoreWorker,
  injectStorageFault,
} from "virtual:neoseq-worker-factory";
import { GraphSession } from "../../core-port/session";
import { graphName, renameGraph } from "../../core-port/directory";
import { isDeleted, pageKind, pageTitle, type PageSnapshot } from "../../core-port/snapshot";
import { Callout } from "../../ui/components";
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
import { addDays, formatJournalTitle, todayLocalDate } from "../../entities/journal";
import { canonicalEntityName, nextAvailableEntityName } from "../../entities/names";
import { CommandContext, type CommandBridge } from "../commands/context";
import { CommandPalette } from "../commands/CommandPalette";
import { ShortcutSheet } from "../commands/ShortcutSheet";
import { parseDateQuery } from "../commands/dates";
import { MOD, isTextEntry, matchGlobal, type KeyBinding } from "../commands/keys";
import { useNotify, type Notifier } from "../notify/context";
import type { RdfTerm } from "../../generated/core-port";
import type { Command } from "../commands/registry";
import { SessionContext } from "./session-context";
import { SaveStatus } from "./SaveStatus";

declare global {
  interface Window {
    __neoseqTest?: {
      injectStorageFault(fault: string): Promise<void>;
    };
  }
}

const RAIL_KEY = "neoseq.rail";

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
  const notify = useNotify();
  const name = useMemo(() => graphName(graphId), [graphId]);
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
  const readonlyAnnounced = useRef(false);

  const readonly = state.mode === "readonly";

  const pages = useMemo(
    () =>
      state.snapshot.pages
        .filter((page) => pageKind(page) === "regular" && !isDeleted(page))
        .sort((left, right) => pageTitle(left).localeCompare(pageTitle(right))),
    [state.snapshot],
  );

  const createPage = useCallback(
    async (title?: string) => {
      const pageId = `p-${crypto.randomUUID()}`;
      const pageName = title ?? nextAvailableEntityName("Untitled", pages.map(pageTitle));
      try {
        await session.execute({ type: "ensure_page", page_id: pageId, title: pageName });
      } catch (error) {
        notify.failure(`Couldn’t create “${pageName}”`, error);
        return;
      }
      navigate(`/g/${graphId}/p/${pageId}`);
    },
    [graphId, navigate, notify, pages, session],
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
      setBlockProperties: (handler) => {
        blockProperties.current = handler;
      },
      setPageProperties: (handler) => {
        pageProperties.current = handler;
      },
      requestProperties: () => (blockProperties.current ?? pageProperties.current)?.(),
      requestPageProperties: () => pageProperties.current?.(),
    }),
    [],
  );

  const applyTheme = useCallback((next: Theme) => {
    setTheme(next);
    setThemeState(next);
  }, []);

  // One listener, one arbitration order. Undo/redo stay outside text fields:
  // inside one, ⌘Z is the platform's text undo, which is what a user editing a
  // page title or a property value expects. The outline's textarea is the
  // exception and handles the document undo itself, because there its text edits
  // *are* the document.
  useEffect(() => {
    const undo = (redo: boolean) => void runHistory(session, notify, redo);
    const bindings: KeyBinding[] = [
      { key: "k", run: () => setPaletteOpen(true) },
      { key: "p", shift: true, run: () => bridge.requestProperties() },
      { key: "/", run: () => setShortcutsOpen(true) },
      { key: "\\", run: toggleRail },
      { key: ",", run: () => navigate(`/g/${graphId}/settings`) },
    ];
    const onKeyDown = (event: KeyboardEvent) => {
      const binding = matchGlobal(event, bindings);
      if (binding) {
        event.preventDefault();
        binding.run(event);
        return;
      }
      if (isTextEntry(event.target)) return;
      const zed = matchGlobal(event, [
        { key: "z", run: () => undo(false) },
        { key: "z", shift: true, run: () => undo(true) },
        { key: "y", run: () => undo(true) },
      ]);
      if (zed) {
        event.preventDefault();
        zed.run(event);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [bridge, graphId, navigate, notify, session, toggleRail]);

  // Read-only is a state a second tab lands in without asking for it, and the
  // 12px label beside the save slot is easy to miss when the first thing you do
  // is start typing. Say it once, plainly, and leave it up until dismissed —
  // the condition it describes does not expire on a timer either. Once really
  // means once: a remount must not reopen a notice the user already closed.
  useEffect(() => {
    if (!readonly || readonlyAnnounced.current) return;
    readonlyAnnounced.current = true;
    notify.show({
      tone: "info",
      key: "readonly-lease",
      duration: null,
      title: "This graph is open in another tab",
      detail:
        "Editing is disabled here so the two tabs cannot overwrite each other. Close the other tab and reload to take over.",
    });
  }, [notify, readonly]);

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

  const today = todayLocalDate();

  // Query-dependent rows: a date the user typed, and — when nothing matches — a
  // page to create, so the list is never a dead end.
  const dynamic = useCallback(
    (query: string): Command[] => {
      if (query.length === 0) return [];
      const rows: Command[] = [];
      const date = parseDateQuery(query, today);
      if (date) {
        rows.push({
          id: `journal-${date}`,
          group: "Journal",
          label: formatJournalTitle(date),
          hint: date === today ? "Today" : "Journal",
          icon: <CalendarDaysIcon aria-hidden />,
          pointerRoute: "the calendar button beside the journal title",
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
          label: `Create page “${query}”`,
          icon: <PlusIcon aria-hidden />,
          pointerRoute: "the ＋ beside Pages in the sidebar, then rename the page",
          run: () => createPage(query),
        });
      }
      return rows;
    },
    [createPage, graphId, navigate, pages, readonly, today],
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
          hint: isBlock ? "Block" : "Page",
          icon: <SearchIcon aria-hidden />,
          pointerRoute: "the Search field in the top bar",
          run: () => navigate(`/g/${graphId}/p/${pageId}`),
        }];
      });
    },
    [graphId, navigate, session],
  );

  // A calm, delayed loader (rather than a full-bleed card) prevents the
  // sub-frame "Opening graph…" flash on fast local opens.
  if (state.status === "opening") return <ShellLoading />;

  if (state.status === "error") {
    return (
      <main className="picker">
        <div className="picker-inner">
          <div className="tombstone" data-testid="graph-error">
            <h1>This graph could not be opened</h1>
            <p>
              {state.error?.message ?? "Unknown error."} ({state.error?.code ?? "internal"})
            </p>
            <div className="actions">
              <Link className="btn" to="/">
                Back to graphs
              </Link>
            </div>
          </div>
        </div>
      </main>
    );
  }

  const journalMatch = /\/journal(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(location.pathname);
  const currentDate = journalMatch ? (journalMatch[1] ?? today) : null;
  const currentPage = /\/p\/([^/]+)$/.exec(location.pathname)?.[1];
  const contextTitle = currentDate
    ? formatJournalTitle(currentDate)
    : currentPage
      ? (pages.find((page) => page.id === currentPage)
          ? pageTitle(pages.find((page) => page.id === currentPage)!)
          : "Page")
      : location.pathname.endsWith("/settings")
        ? "Settings"
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
  });

  return (
    <CommandContext.Provider value={bridge}>
      <div className="shell" data-rail={railCollapsed ? "collapsed" : "expanded"}>
        <a className="skip-link" href="#page-content">
          Skip to content
        </a>
        {sidebarOpen && (
          <button className="shell-scrim" aria-label="Close menu" onClick={onToggleSidebar} />
        )}
        <nav
          className="shell-sidebar"
          data-open={sidebarOpen}
          aria-label="Graph navigation"
          data-testid="sidebar"
        >
          <GraphSwitcher graphId={graphId} name={name} onExit={onExit} />
          <div className="shell-nav">
            <NavLink className="shell-nav-item" to={`/g/${graphId}/journal`} end>
              <CalendarDaysIcon aria-hidden />
              <span className="nav-label">Journal</span>
            </NavLink>
          </div>
          <div className="rail-group">
            <h2>Pages</h2>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="icon-btn"
                  aria-label="New page"
                  onClick={() => void createPage()}
                  data-testid="new-page"
                >
                  <PlusIcon aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent>New page</TooltipContent>
            </Tooltip>
          </div>
          <div className="shell-nav" data-testid="page-list">
            {pages.length === 0 && <p className="rail-note">No pages yet.</p>}
            {pages.map((page) => (
              <NavLink key={page.id} className="shell-nav-item" to={`/g/${graphId}/p/${page.id}`}>
                <FileTextIcon aria-hidden />
                <span className="nav-label">{pageTitle(page)}</span>
              </NavLink>
            ))}
          </div>
          <div className="rail-spacer" />
          <div className="rail-footer">
            <NavLink className="shell-nav-item" to={`/g/${graphId}/settings`}>
              <SettingsIcon aria-hidden />
              <span className="nav-label">Settings</span>
            </NavLink>
            <button className="shell-nav-item" onClick={onExit}>
              <LayoutGridIcon aria-hidden />
              <span className="nav-label">All graphs</span>
            </button>
          </div>
        </nav>
        <main className="shell-main">
          <header className="shell-topbar" data-scrolled={scrolled}>
            <button
              className="icon-btn shell-toggle"
              aria-label={sidebarOpen ? "Close menu" : "Open menu"}
              aria-expanded={sidebarOpen}
              onClick={onToggleSidebar}
            >
              <PanelLeftIcon />
            </button>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="icon-btn rail-toggle"
                  aria-label="Show sidebar"
                  aria-keyshortcuts="Meta+Backslash"
                  onClick={toggleRail}
                >
                  <PanelLeftIcon />
                </button>
              </TooltipTrigger>
              <TooltipContent>Show sidebar · {MOD}\</TooltipContent>
            </Tooltip>
            <span className="topbar-title" aria-hidden>
              {contextTitle}
            </span>
            <div className="topbar-right">
              <button
                className="search-pill"
                onClick={() => setPaletteOpen(true)}
                aria-label="Search pages and commands"
                aria-keyshortcuts="Meta+K"
                data-testid="open-palette"
              >
                <SearchIcon aria-hidden />
                <span className="label">Search</span>
                <kbd className="kbd">{MOD}K</kbd>
              </button>
              <SaveStatus state={state} onRetry={() => void session.retry()} />
              {readonly && (
                <span className="readonly-label" data-testid="readonly-pill">
                  Read-only · open in another tab
                </span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="icon-btn"
                    aria-label="Undo"
                    aria-keyshortcuts="Meta+Z"
                    disabled={readonly}
                    onClick={() => void runHistory(session, notify, false)}
                    data-testid="undo"
                  >
                    <Undo2Icon aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Undo · {MOD}Z</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="icon-btn"
                    aria-label="Redo"
                    aria-keyshortcuts="Meta+Shift+Z"
                    disabled={readonly}
                    onClick={() => void runHistory(session, notify, true)}
                    data-testid="redo"
                  >
                    <Redo2Icon aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent>Redo · {MOD}⇧Z</TooltipContent>
              </Tooltip>
            </div>
          </header>
          <div className="shell-content" id="page-content">
            {state.recovery && state.recovery.quarantined_records.length > 0 && (
              <div className="callout-slot">
                <Callout tone="danger">
                  {state.recovery.quarantined_records.length} damaged record(s) were quarantined
                  during recovery. Intact data up to the last valid state was restored.
                </Callout>
              </div>
            )}
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
    </CommandContext.Provider>
  );
}

function literalText(term: RdfTerm | undefined): string {
  return term?.kind === "literal" ? term.value : "";
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
  const navigate = useNavigate();
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
          aria-label="Graph name"
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
          Rename graph
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate(`/g/${graphId}/settings`)}>
          Graph settings
          <DropdownMenuShortcut>{MOD},</DropdownMenuShortcut>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onExit}>All graphs</DropdownMenuItem>
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
}

/**
 * Undo and redo are the two verbs the interface offers with no visible result
 * of their own when they fail: the graph simply does not move. Reporting is the
 * only thing that separates "there was nothing to undo" from "the command was
 * rejected", so neither path is allowed to swallow its error.
 */
function runHistory(session: GraphSession, notify: Notifier, redo: boolean): Promise<void> {
  return session
    .execute({ type: redo ? "redo" : "undo" })
    .then(() => undefined)
    .catch((error: unknown) => {
      notify.failure(redo ? "Couldn’t redo" : "Couldn’t undo", error);
    });
}

const THEME_LABEL: Record<Theme, string> = {
  system: "Match the system",
  light: "Light",
  dark: "Dark",
};

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
  } = input;
  const blocked = readonly ? "Read-only — this graph is open in another tab" : null;
  const commands: Command[] = [];

  for (const page of pages) {
    const title = pageTitle(page);
    commands.push({
      id: `page-${page.id}`,
      group: "Pages",
      label: title,
      keywords: ["open page", "go to"],
      hint: "Page",
      icon: <FileTextIcon aria-hidden />,
      pointerRoute: "the page list in the sidebar",
      run: () => navigate(`/g/${graphId}/p/${page.id}`),
    });
  }

  commands.push({
    id: "new-page",
    group: "Pages",
    label: "New page",
    keywords: ["create", "add page"],
    icon: <PlusIcon aria-hidden />,
    disabledReason: blocked,
    pointerRoute: "the ＋ beside Pages in the sidebar",
    run: () => void createPage(),
  });

  commands.push({
    id: "journal-today",
    group: "Journal",
    label: "Today’s journal",
    keywords: ["today", "journal", "daily"],
    hint: formatJournalTitle(today),
    icon: <CalendarDaysIcon aria-hidden />,
    pointerRoute: "Journal in the sidebar",
    run: () => navigate(`/g/${graphId}/journal`),
  });

  if (currentDate) {
    commands.push(
      {
        id: "journal-prev",
        group: "Journal",
        label: "Previous day",
        icon: <CalendarDaysIcon aria-hidden />,
        pointerRoute: "the ‹ beside the journal title",
        run: () => navigate(`/g/${graphId}/journal/${addDays(currentDate, -1)}`),
      },
      {
        id: "journal-next",
        group: "Journal",
        label: "Next day",
        icon: <CalendarDaysIcon aria-hidden />,
        pointerRoute: "the › beside the journal title",
        run: () => navigate(`/g/${graphId}/journal/${addDays(currentDate, 1)}`),
      },
    );
  }

  commands.push({
    id: "properties",
    group: "Block",
    label: "Properties & tags",
    keywords: ["property", "tag", "metadata"],
    binding: `${MOD}⇧P`,
    hint: "This block, or the page",
    icon: <Settings2Icon aria-hidden />,
    pointerRoute: "the ⋯ on a row, or the ⋯ beside the page title",
    run: () => bridge.requestProperties(),
  });

  commands.push(
    {
      id: "undo",
      group: "Edit",
      label: "Undo",
      binding: `${MOD}Z`,
      icon: <Undo2Icon aria-hidden />,
      disabledReason: blocked,
      pointerRoute: "the undo arrow in the top bar",
      run: () => void runHistory(session, notify, false),
    },
    {
      id: "redo",
      group: "Edit",
      label: "Redo",
      binding: `${MOD}⇧Z`,
      icon: <Redo2Icon aria-hidden />,
      disabledReason: blocked,
      pointerRoute: "the redo arrow in the top bar",
      run: () => void runHistory(session, notify, true),
    },
  );

  commands.push(
    {
      id: "settings",
      group: "Graph",
      label: "Settings",
      binding: `${MOD},`,
      icon: <SettingsIcon aria-hidden />,
      pointerRoute: "Settings at the bottom of the sidebar",
      run: () => navigate(`/g/${graphId}/settings`),
    },
    {
      id: "all-graphs",
      group: "Graph",
      label: "All graphs",
      keywords: ["switch graph", "close graph"],
      icon: <LayoutGridIcon aria-hidden />,
      pointerRoute: "All graphs at the bottom of the sidebar",
      run: onExit,
    },
  );

  commands.push(
    {
      id: "theme",
      group: "App",
      label: `Appearance: ${THEME_LABEL[theme]}`,
      keywords: ["dark mode", "light mode", "theme"],
      hint: `Switch to ${THEME_LABEL[nextTheme(theme)].toLowerCase()}`,
      icon: <MoonIcon aria-hidden />,
      pointerRoute: "Settings → Appearance",
      run: () => applyTheme(nextTheme(theme)),
    },
    {
      id: "toggle-rail",
      group: "App",
      label: railCollapsed ? "Show sidebar" : "Hide sidebar",
      binding: `${MOD}\\`,
      icon: <PanelLeftIcon aria-hidden />,
      pointerRoute: "the sidebar icon in the top bar",
      run: toggleRail,
    },
    {
      id: "shortcuts",
      group: "App",
      label: "Keyboard shortcuts",
      binding: `${MOD}/`,
      icon: <KeyboardIcon aria-hidden />,
      pointerRoute: "the palette’s Keyboard shortcuts entry",
      run: () => bridge.openShortcuts(),
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
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), 220);
    return () => clearTimeout(timer);
  }, []);

  if (!show) return <div className="shell-loading" aria-busy="true" />;
  return (
    <div className="shell-loading" role="status" aria-busy="true">
      <Loader2Icon className="spinner" aria-hidden />
      <p>Opening graph…</p>
    </div>
  );
}
