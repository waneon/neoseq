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
import { addDays, todayLocalDate } from "../../entities/journal";
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
import { useI18n, type MessageFunction } from "../../i18n";

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
  const { message, locale, formatLocalDate, compare } = useI18n();
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
    const undo = (redo: boolean) => void runHistory(session, notify, message, redo);
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
  }, [bridge, graphId, message, navigate, notify, session, toggleRail]);

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
      title: message("shell.readonlyTitle"),
      detail: message("shell.readonlyDetail"),
    });
  }, [message, notify, readonly]);

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
      const date = parseDateQuery(query, today, locale);
      if (date) {
        rows.push({
          id: `journal-${date}`,
          group: "Journal",
          label: formatLocalDate(date),
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
    [createPage, formatLocalDate, graphId, locale, message, navigate, pages, readonly, today],
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

  const journalMatch = /\/journal(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(location.pathname);
  const currentDate = journalMatch ? (journalMatch[1] ?? today) : null;
  const currentPage = /\/p\/([^/]+)$/.exec(location.pathname)?.[1];
  const contextTitle = currentDate
    ? formatLocalDate(currentDate)
    : currentPage
      ? (pages.find((page) => page.id === currentPage)
          ? pageTitle(pages.find((page) => page.id === currentPage)!)
          : message("common.page"))
      : location.pathname.endsWith("/settings")
        ? message("settings.title")
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
    formatLocalDate,
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
          <GraphSwitcher graphId={graphId} name={name} onExit={onExit} />
          <div className="shell-nav">
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
            <NavLink className="shell-nav-item" to={`/g/${graphId}/settings`}>
              <SettingsIcon aria-hidden />
              <span className="nav-label">{message("shell.settings")}</span>
            </NavLink>
            <button className="shell-nav-item" onClick={onExit}>
              <LayoutGridIcon aria-hidden />
              <span className="nav-label">{message("shell.allGraphs")}</span>
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
                  aria-keyshortcuts="Meta+Backslash"
                  onClick={toggleRail}
                >
                  <PanelLeftIcon />
                </button>
              </TooltipTrigger>
              <TooltipContent>{message("shell.showSidebar")} · {MOD}\</TooltipContent>
            </Tooltip>
            <span className="topbar-title" aria-hidden>
              {contextTitle}
            </span>
            <div className="topbar-right">
              <button
                className="search-pill"
                onClick={() => setPaletteOpen(true)}
                aria-label={message("commands.searchLabel")}
                aria-keyshortcuts="Meta+K"
                data-testid="open-palette"
              >
                <SearchIcon aria-hidden />
                <span className="label">{message("shell.search")}</span>
                <kbd className="kbd">{MOD}K</kbd>
              </button>
              <SaveStatus state={state} onRetry={() => void session.retry()} />
              {readonly && (
                <span className="readonly-label" data-testid="readonly-pill">
                  {message("shell.readonly")}
                </span>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="icon-btn"
                    aria-label={message("shell.undo")}
                    aria-keyshortcuts="Meta+Z"
                    disabled={readonly}
                    onClick={() => void runHistory(session, notify, message, false)}
                    data-testid="undo"
                  >
                    <Undo2Icon aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{message("shell.undo")} · {MOD}Z</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    className="icon-btn"
                    aria-label={message("shell.redo")}
                    aria-keyshortcuts="Meta+Shift+Z"
                    disabled={readonly}
                    onClick={() => void runHistory(session, notify, message, true)}
                    data-testid="redo"
                  >
                    <Redo2Icon aria-hidden />
                  </button>
                </TooltipTrigger>
                <TooltipContent>{message("shell.redo")} · {MOD}⇧Z</TooltipContent>
              </Tooltip>
            </div>
          </header>
          <div className="shell-content" id="page-content">
            {state.recovery && state.recovery.quarantined_records.length > 0 && (
              <div className="callout-slot">
                <Callout tone="danger">
                  {message("shell.recovery", {
                    count: state.recovery.quarantined_records.length,
                  })}
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
  const { message } = useI18n();
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
        <DropdownMenuItem onSelect={() => navigate(`/g/${graphId}/settings`)}>
          {message("graph.settings")}
          <DropdownMenuShortcut>{MOD},</DropdownMenuShortcut>
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
  formatLocalDate: (date: string) => string;
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
    formatLocalDate,
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

  commands.push({
    id: "journal-today",
    group: "Journal",
    label: message("commands.label.todayJournal"),
    keywords: ["today", "journal", "daily"],
    hint: formatLocalDate(today),
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
    binding: `${MOD}⇧P`,
    hint: message("commands.pagePropertiesHint"),
    icon: <Settings2Icon aria-hidden />,
    pointerRoute: message("shortcuts.blockActionsRoute"),
    run: () => bridge.requestProperties(),
  });

  commands.push(
    {
      id: "undo",
      group: "Edit",
      label: message("commands.label.undo"),
      binding: `${MOD}Z`,
      icon: <Undo2Icon aria-hidden />,
      disabledReason: blocked,
      pointerRoute: message("shell.undo"),
      run: () => void runHistory(session, notify, message, false),
    },
    {
      id: "redo",
      group: "Edit",
      label: message("commands.label.redo"),
      binding: `${MOD}⇧Z`,
      icon: <Redo2Icon aria-hidden />,
      disabledReason: blocked,
      pointerRoute: message("shell.redo"),
      run: () => void runHistory(session, notify, message, true),
    },
  );

  commands.push(
    {
      id: "settings",
      group: "Graph",
      label: message("commands.label.settings"),
      binding: `${MOD},`,
      icon: <SettingsIcon aria-hidden />,
      pointerRoute: message("shell.settings"),
      run: () => navigate(`/g/${graphId}/settings`),
    },
    {
      id: "all-graphs",
      group: "Graph",
      label: message("commands.label.allGraphs"),
      keywords: ["switch graph", "close graph"],
      icon: <LayoutGridIcon aria-hidden />,
      pointerRoute: message("shell.allGraphs"),
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
      binding: `${MOD}\\`,
      icon: <PanelLeftIcon aria-hidden />,
      pointerRoute: message("shell.showSidebar"),
      run: toggleRail,
    },
    {
      id: "shortcuts",
      group: "App",
      label: message("commands.label.keyboardShortcuts"),
      binding: `${MOD}/`,
      icon: <KeyboardIcon aria-hidden />,
      pointerRoute: message("commands.label.keyboardShortcuts"),
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
  const { message } = useI18n();
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), 220);
    return () => clearTimeout(timer);
  }, []);

  if (!show) return <div className="shell-loading" aria-busy="true" />;
  return (
    <div className="shell-loading" role="status" aria-busy="true">
      <Loader2Icon className="spinner" aria-hidden />
      <p>{message("graph.loading")}</p>
    </div>
  );
}
