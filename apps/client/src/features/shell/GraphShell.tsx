import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
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
  ChevronsUpDownIcon,
  FileTextIcon,
  HashIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  PanelLeftIcon,
  PlusIcon,
  SearchIcon,
  SettingsIcon,
} from "lucide-react";
import { clearTestHook, createCoreWorker, injectStorageFault } from "virtual:neoseq-worker-factory";
import { GraphSession } from "../../core-port/session";
import type { Command as CoreCommand } from "../../core-port/commands";
import {
  graphConnection,
  graphName,
  renameGraph,
  subscribeGraphDirectory,
} from "../../core-port/directory";
import { findTag, isDeleted, pageKind, pageTitle } from "../../core-port/snapshot";
import {
  FAVOURITE_ORDER_KEY,
  favouriteKey,
  favourites,
  moveFavourite,
  type Favourite,
} from "../../entities/favourites";
import { TagMark } from "../tags/TagIdentity";
import { Wordmark } from "../../ui/brand";
import { Input } from "@/ui/shadcn/input";
import { Button } from "@/ui/shadcn/button";
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
import { setTheme, storedTheme, type Theme } from "../../ui/theme";
import { todayLocalDate } from "../../entities/journal";
import { canonicalEntityName, nextAvailableEntityName } from "../../entities/names";
import {
  CommandContext,
  createContextualHandlerRegistry,
  useCommands,
  type CommandBridge,
  type PageActions,
} from "../commands/context";
import { CommandPalette } from "../commands/CommandPalette";
import { Shortcut } from "../commands/Shortcut";
import { ShortcutSheet } from "../commands/ShortcutSheet";
import { isTextEntry } from "../commands/keys";
import {
  formatBinding,
  bindingMatches,
  matchShortcut,
  useShortcutBindings,
  type Binding,
  type ShortcutHandler,
  type ShortcutId,
} from "../commands/shortcuts";
import { useNotify, type Notifier } from "../notify/context";
import type { RdfTerm } from "../../generated/core-port";
import type { Command as PaletteCommand } from "../commands/registry";
import { buildCommands, runHistory } from "../commands/catalog";
import {
  SettingsDialog,
  isSettingsSection,
  type SettingsSection,
  SETTINGS_PARAM,
} from "../settings/SettingsDialog";
import { SessionContext, useSession, useSessionSelector } from "./session-context";
import { SaveStatus } from "./SaveStatus";
import { CollaborationStatus } from "./CollaborationStatus";
import { RemoteMembersDialog } from "../sync/RemoteMembersDialog";
import { useI18n, type MessageFunction } from "../../i18n";
import { useProgressiveItems } from "../../lib/progressive";
import { HistoryProvider, useHistoryActions } from "../history/context";

declare global {
  interface Window {
    __neoseqTest?: {
      injectStorageFault(fault: string): Promise<void>;
    };
  }
}

const RAIL_KEY = "neoseq.rail";

type ShellOverlay = "palette" | "shortcuts" | "members" | null;

export function GraphShell() {
  const { graphId = "" } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [createdSession, setCreatedSession] = useState<GraphSession | null>(null);
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
      created = new GraphSession(graphId, worker, graphConnection(graphId));
      setCreatedSession(created);
      void created.open();
      const faultInjector = injectStorageFault;
      if (faultInjector) {
        window.__neoseqTest = {
          injectStorageFault: (fault: string) => faultInjector(worker, `local:${graphId}`, fault),
        };
      }
    })();
    return () => {
      cancelled = true;
      clearTestHook();
      setCreatedSession((current) => (current === created ? null : current));
      void created?.close();
    };
  }, [graphId]);

  useEffect(() => {
    setSidebarOpen(false);
  }, [location]);

  const session = createdSession?.graphId === graphId ? createdSession : null;
  if (!session) return <ShellLoading />;
  return (
    <SessionContext.Provider value={session}>
      <HistoryProvider session={session} graphId={graphId}>
        <ShellBody
          key={graphId}
          session={session}
          graphId={graphId}
          sidebarOpen={sidebarOpen}
          onToggleSidebar={() => setSidebarOpen((open) => !open)}
          onExit={() => navigate("/")}
        />
      </HistoryProvider>
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
  const state = useSessionSelector(
    (current) => current,
    (left, right) =>
      left.status === right.status &&
      left.mode === right.mode &&
      left.snapshot === right.snapshot &&
      left.recovery === right.recovery,
  );
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const notify = useNotify();
  const { message, temporal, formatJournalDate, compare } = useI18n();
  const bindings = useShortcutBindings();
  const history = useHistoryActions();
  // Renaming happens in the settings dialog, which sits over this rail; both have
  // to say the same thing while they are on screen together.
  const name = useSyncExternalStore(
    subscribeGraphDirectory,
    () => graphName(graphId),
    () => graphName(graphId),
  );
  const [overlay, setOverlay] = useState<ShellOverlay>(null);
  const [theme, setThemeState] = useState<Theme>(storedTheme);
  const [railCollapsed, setRailCollapsed] = useState(() => {
    try {
      return localStorage.getItem(RAIL_KEY) === "collapsed";
    } catch {
      return false;
    }
  });
  const [scrolled, setScrolled] = useState(false);
  const [, refreshCommandContext] = useReducer((revision: number) => revision + 1, 0);
  const blockProperties = useRef(createContextualHandlerRegistry<(key?: string) => void>());
  const pageProperties = useRef<((key?: string) => void) | null>(null);
  const pageActions = useRef<PageActions | null>(null);
  const readonlyAnnounced = useRef(false);
  const recoveryAnnounced = useRef(false);

  const readonly = state.mode === "readonly";
  const remote = graphConnection(graphId);

  // The open settings section lives in the URL, so the browser's own Back closes
  // the dialog and a link can point straight at one section.
  const settingsParam = searchParams.get(SETTINGS_PARAM);
  const settingsSection = isSettingsSection(settingsParam) ? settingsParam : null;

  const openSettings = useCallback(
    (section: SettingsSection = "appearance") => {
      setOverlay(null);
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

  const currentPage = /\/p\/([^/]+)$/.exec(location.pathname)?.[1];
  const pages = useMemo(
    () =>
      state.snapshot.pages
        .filter((page) => pageKind(page) === "regular" && !isDeleted(page))
        .sort((left, right) => compare(pageTitle(left), pageTitle(right))),
    [compare, state.snapshot],
  );
  const pageWindow = useProgressiveItems(pages, (page) => page.id, 100, currentPage);

  const tags = useMemo(
    () => [...state.snapshot.tags].sort((left, right) => compare(left.name, right.name)),
    [compare, state.snapshot],
  );

  const starred = useMemo(() => favourites(state.snapshot, compare), [compare, state.snapshot]);

  const createPage = useCallback(
    async (title?: string) => {
      const pageId = `p-${crypto.randomUUID()}`;
      const pageName =
        title ?? nextAvailableEntityName(message("page.untitled"), pages.map(pageTitle));
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
      openPalette: () => setOverlay("palette"),
      openShortcuts: () => setOverlay("shortcuts"),
      openSettings,
      registerBlockProperties: (handler) => {
        const release = blockProperties.current.register(handler);
        refreshCommandContext();
        return () => {
          release();
          refreshCommandContext();
        };
      },
      setPageProperties: (handler) => {
        pageProperties.current = handler;
        refreshCommandContext();
      },
      setPageActions: (actions) => {
        pageActions.current = actions;
        refreshCommandContext();
      },
      availability: () => ({
        properties:
          blockProperties.current.current() !== undefined || pageProperties.current !== null,
        pageInfo: pageActions.current !== null,
        pageDelete: pageActions.current?.remove !== undefined,
      }),
      requestProperties: (key?: string) => {
        const handler = blockProperties.current.current() ?? pageProperties.current;
        if (!handler) return false;
        handler(key);
        return true;
      },
      requestPageInfo: () => {
        const action = pageActions.current?.info;
        if (!action) return false;
        action();
        return true;
      },
      requestPageDelete: () => {
        const action = pageActions.current?.remove;
        if (!action) return false;
        action();
        return true;
      },
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
  const overlayOpen = settingsSection !== null || overlay !== null;
  useEffect(() => {
    const undo = (redo: boolean) =>
      void runHistory(history, notify, message, redo, { kind: "global-shortcut" });
    const handlers: ShortcutHandler[] = [
      { binding: bindings.palette, run: () => setOverlay("palette") },
      { binding: bindings.shortcuts, run: () => setOverlay("shortcuts") },
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
    history,
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

  const today = todayLocalDate();
  const journalMatch = /\/journal(?:\/(\d{4}-\d{2}-\d{2}))?$/.exec(location.pathname);
  const currentDate = journalMatch ? (journalMatch[1] ?? today) : null;
  const currentTag = /\/t\/([^/]+)$/.exec(location.pathname)?.[1];
  // Query-dependent rows: a date the user typed, and — when nothing matches — a
  // page to create, so the list is never a dead end.
  const dynamic = useCallback(
    (query: string): PaletteCommand[] => {
      if (query.length === 0) return [];
      const rows: PaletteCommand[] = [];
      const dateResult = temporal.parseDate(query, { today });
      const date = dateResult.kind === "match" ? dateResult.value : null;
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
    [createPage, formatJournalDate, graphId, message, navigate, pages, readonly, temporal, today],
  );

  const searchGraph = useCallback(
    async (needle: string): Promise<PaletteCommand[]> => {
      const result = await session.query({
        language: "sparql-1.1/neoseq-v1",
        source: `PREFIX neo: <urn:neoseq:vocab:v1:>
SELECT ?entity ?content WHERE {
  { ?entity a neo:Page; neo:content ?content. }
  UNION
  { ?entity a neo:Block; neo:content ?content. }
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
        const content = literalText(row.content);
        if (entity?.kind !== "iri" || !entity.entity) return [];
        const isBlock = entity.entity.kind === "block";
        return [
          {
            id: `search-${index}-${entity.value}`,
            group: "Search" as const,
            label: content || entity.entity.id,
            hint: isBlock ? message("commands.blockHint") : message("commands.hintPage"),
            icon: <SearchIcon aria-hidden />,
            pointerRoute: message("shell.search"),
            run: () => history.open(entity.entity!),
          },
        ];
      });
    },
    [history, message, session],
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
              <Button asChild variant="secondary">
                <Link to="/">{message("graph.backToGraphs")}</Link>
              </Button>
            </div>
          </div>
        </div>
      </main>
    );
  }

  const contextTitle = currentDate
    ? formatJournalDate(currentDate)
    : currentPage
      ? pages.find((page) => page.id === currentPage)
        ? pageTitle(pages.find((page) => page.id === currentPage)!)
        : message("common.page")
      : currentTag
        ? `#${findTag(state.snapshot, decodeURIComponent(currentTag))?.name ?? currentTag}`
        : location.pathname.endsWith("/tags")
          ? message("shell.tags")
          : name;

  const commands = buildCommands({
    pages,
    tags,
    graphId,
    today,
    currentDate,
    readonly,
    theme,
    navigate,
    createPage,
    onExit,
    notify,
    bridge,
    openMembers: remote ? () => setOverlay("members") : null,
    toggleRail,
    railCollapsed,
    applyTheme,
    message,
    formatJournalDate,
    bindings,
    history,
    commandAvailability: bridge.availability(),
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
          {/* The mark and the graph read as one head: the product's name small
              and quiet above, the graph — the thing a reader actually switches —
              as the row with weight and an initial beside it. */}
          <div className="rail-head">
            <p className="rail-brand" data-testid="brand">
              <Wordmark name={message("app.title")} />
            </p>
            <GraphSwitcher
              graphId={graphId}
              name={name}
              remote={remote !== null}
              onManageMembers={() => setOverlay("members")}
              onExit={onExit}
            />
          </div>
          {/* Search is the affordance that licenses how bare the rest of the
              interface is, so it stays permanent — and it wears the shape of the
              field it stands in for, with its key badge always showing, rather
              than passing for one more place you can go. */}
          <button
            className="rail-search"
            onClick={() => setOverlay("palette")}
            aria-label={message("commands.searchLabel")}
            aria-keyshortcuts={formatBinding(bindings.palette)}
            data-testid="open-palette"
          >
            <SearchIcon aria-hidden />
            <span className="nav-label">{message("shell.search")}</span>
            <Shortcut binding={bindings.palette} />
          </button>
          <div className="shell-nav">
            <NavLink className="shell-nav-item" to={`/g/${graphId}/journal`} end>
              <CalendarDaysIcon aria-hidden />
              <span className="nav-label">{message("shell.journal")}</span>
            </NavLink>
            <NavLink
              className="shell-nav-item"
              to={`/g/${graphId}/tags`}
              end
              data-testid="nav-tags"
            >
              <HashIcon aria-hidden />
              <span className="nav-label">{message("shell.tags")}</span>
            </NavLink>
          </div>
          {/* Nothing when nothing is starred: an empty heading is a promise the
              rail has not been asked to keep
              (designs/interaction.md § Feedback and System State). */}
          {starred.length > 0 && (
            <>
              <div className="rail-group">
                <h2>{message("shell.favourites")}</h2>
              </div>
              <FavouriteRail
                graphId={graphId}
                starred={starred}
                readonly={readonly}
                session={session}
                notify={notify}
                message={message}
              />
            </>
          )}
          <div className="rail-group">
            <h2>{message("shell.pages")}</h2>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  aria-label={message("shell.newPage")}
                  onClick={() => void createPage()}
                  data-testid="new-page"
                >
                  <PlusIcon aria-hidden />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{message("shell.newPage")}</TooltipContent>
            </Tooltip>
          </div>
          <div className="shell-nav" data-testid="page-list">
            {pages.length === 0 && <p className="rail-note">{message("shell.noPages")}</p>}
            {pageWindow.items.map((page) => (
              // The rail is 248px wide and a page name is as long as somebody
              // made it, so the label ellipsises — and an ellipsis with no way to
              // read the rest is a name the reader cannot check.
              <NavLink
                key={page.id}
                className="shell-nav-item"
                to={`/g/${graphId}/p/${page.id}`}
                title={pageTitle(page)}
              >
                <FileTextIcon aria-hidden />
                <span className="nav-label">{pageTitle(page)}</span>
              </NavLink>
            ))}
            {pageWindow.remaining > 0 && (
              <button
                type="button"
                className="shell-nav-item rail-more"
                onClick={pageWindow.showMore}
              >
                {message("shell.showMorePages", {
                  count: Math.min(pageWindow.remaining, 100),
                })}
              </button>
            )}
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
            <Button
              size="icon"
              className="shell-toggle"
              aria-label={sidebarOpen ? message("shell.closeMenu") : message("shell.openMenu")}
              aria-expanded={sidebarOpen}
              onClick={onToggleSidebar}
            >
              <PanelLeftIcon />
            </Button>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  className="rail-toggle"
                  aria-label={message("shell.showSidebar")}
                  aria-keyshortcuts={formatBinding(bindings.sidebar)}
                  onClick={toggleRail}
                >
                  <PanelLeftIcon />
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {message("shell.showSidebar")} · {formatBinding(bindings.sidebar)}
              </TooltipContent>
            </Tooltip>
            <span className="topbar-title" aria-hidden>
              {contextTitle}
            </span>
            {/* State, then the one verb. Durability and the read-only lease each
                render nothing when there is nothing to say; the overflow menu is always the last thing on the
                bar, which is where every application this one resembles puts
                "everything else". */}
            <div className="topbar-right">
              <SessionSaveStatus />
              <SessionCollaborationStatus />
              {readonly && (
                <span className="readonly-label" data-testid="readonly-pill">
                  {message("shell.readonly")}
                </span>
              )}
              <OverflowMenu
                commands={commands}
                onOpenPalette={() => setOverlay("palette")}
                bindings={bindings}
              />
            </div>
          </header>
          <div className="shell-content" id="page-content">
            <Outlet />
          </div>
        </main>
      </div>
      {overlay === "palette" && (
        <CommandPalette
          commands={commands}
          dynamic={dynamic}
          search={searchGraph}
          onClose={() => setOverlay(null)}
        />
      )}
      {overlay === "shortcuts" && <ShortcutSheet onClose={() => setOverlay(null)} />}
      {overlay === "members" && remote && (
        <RemoteMembersDialog
          graphId={graphId}
          connection={remote}
          onClose={() => setOverlay(null)}
        />
      )}
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

function SessionSaveStatus() {
  const session = useSession();
  const save = useSessionSelector((state) => state.save);
  return <SaveStatus save={save} onRetry={() => void session.retry()} />;
}

function SessionCollaborationStatus() {
  const sync = useSessionSelector((state) => state.sync);
  const live = useSessionSelector((state) => state.live);
  return <CollaborationStatus sync={sync} live={live} />;
}

function literalText(term: RdfTerm | undefined): string {
  return term?.kind === "literal" ? term.value : "";
}

/**
 * The starred list, in the reader's own order.
 *
 * Alphabetical was an order nobody chose, and the rail is the one surface a
 * reader scans without reading it: the two places they live in belong at the top,
 * not wherever their initials fell. So the rows are dragged, and the arrangement
 * is graph data (`entities/favourites`).
 *
 * **A drag says where it will land.** The mark is a *seam* — one accent rule in
 * the gap the row is about to occupy — the same answer the tag manager gives, for
 * the same reason: a wash over the row under the pointer answers "which row",
 * which is not the question once a list has an order. Nothing reflows while the
 * pointer travels; rows sliding out from under a drag is the interface guessing,
 * and the guess is wrong on every frame the reader changes their mind.
 *
 * `Alt` with an arrow is the same move from a keyboard, because a rail row is a
 * link and a link has no menu to hang a verb on — and a reorder nobody can reach
 * without a mouse is a reorder half the readers do not have.
 */
function FavouriteRail({
  graphId,
  starred,
  readonly,
  session,
  notify,
  message,
}: {
  graphId: string;
  starred: Favourite[];
  readonly: boolean;
  session: GraphSession;
  notify: Notifier;
  message: MessageFunction;
}) {
  /** The row in the reader's hand, and the gap it would drop into. */
  const [drag, setDrag] = useState<{
    carried: string;
    seam: { key: string; side: "before" | "after" } | null;
  } | null>(null);

  const release = () => setDrag(null);

  const place = (moved: Favourite, before: Favourite | null) => {
    // A row dropped back where it already was is not an edit. Dropping the
    // filter here rather than at every call site is also what keeps a respace
    // from rewriting the positions it would not have changed.
    const writes = moveFavourite(starred, moved, before).filter(
      (write) => write.order !== write.entry.order,
    );
    if (writes.length === 0) return;
    // Reordering is one gesture. Every affected position commits and undoes as
    // one graph transaction, so the rail never exposes an intermediate order.
    const commands: CoreCommand[] = writes.map((write) => ({
      type: "set_property",
      owner:
        write.entry.kind === "page"
          ? { kind: "page", id: write.entry.id }
          : { kind: "tag", tag_id: write.entry.id },
      key: FAVOURITE_ORDER_KEY,
      value: { type: "number", value: write.order },
    }));
    void session
      .execute(commands.length === 1 ? commands[0] : { type: "batch", commands })
      .catch((cause: unknown) =>
        notify.failure(message("failure.moveFavourite", { name: moved.name }), cause),
      );
  };

  const drop = () => {
    if (!drag?.seam) {
      release();
      return;
    }
    const { carried, seam } = drag;
    const moved = starred.find((entry) => favouriteKey(entry) === carried);
    const at = starred.findIndex((entry) => favouriteKey(entry) === seam.key);
    // A row starred elsewhere while the pointer travelled can take the seam's
    // row out from under it; a drop with nowhere to land is no drop.
    if (moved && at >= 0) {
      const before = seam.side === "before" ? starred[at] : starred[at + 1];
      place(moved, before ?? null);
    }
    release();
  };

  /** The keyboard's half of the drag: one step, in the direction it was pressed. */
  const nudge = (entry: Favourite, delta: -1 | 1) => {
    const from = starred.findIndex((item) => favouriteKey(item) === favouriteKey(entry));
    const to = from + delta;
    if (from < 0 || to < 0 || to >= starred.length) return;
    const before = delta < 0 ? starred[to] : starred[to + 1];
    place(entry, before ?? null);
  };

  return (
    <div className="shell-nav" data-testid="favourite-list">
      {starred.map((entry) => {
        const key = favouriteKey(entry);
        return (
          <NavLink
            key={key}
            className="shell-nav-item"
            to={
              entry.kind === "page" ? `/g/${graphId}/p/${entry.id}` : `/g/${graphId}/t/${entry.id}`
            }
            title={entry.name}
            data-testid="favourite-item"
            data-dragging={drag?.carried === key || undefined}
            data-seam={drag?.seam?.key === key ? drag.seam.side : undefined}
            draggable={!readonly}
            aria-keyshortcuts={readonly ? undefined : "Alt+ArrowUp Alt+ArrowDown"}
            onDragStart={(event) => {
              if (readonly) return;
              // A payload is what makes the drag real to the browser; the row
              // being moved is held in React state, where a drop can read it.
              event.dataTransfer.setData("text/plain", entry.name);
              event.dataTransfer.effectAllowed = "move";
              setDrag({ carried: key, seam: null });
            }}
            onDragEnd={release}
            onDragOver={(event) => {
              if (drag === null || drag.carried === key) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              const box = event.currentTarget.getBoundingClientRect();
              setDrag({
                ...drag,
                seam: {
                  key,
                  side: event.clientY < box.top + box.height / 2 ? "before" : "after",
                },
              });
            }}
            onDrop={(event) => {
              if (drag === null) return;
              event.preventDefault();
              drop();
            }}
            onKeyDown={(event) => {
              if (readonly || !event.altKey) return;
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              event.preventDefault();
              nudge(entry, event.key === "ArrowUp" ? -1 : 1);
            }}
          >
            {/* A tag keeps its own mark here, in its own colour, so the list
                reads as the things themselves rather than as rows that happen
                to point at them. */}
            {entry.kind === "page" ? <FileTextIcon aria-hidden /> : <TagMark tag={entry.tag} />}
            <span className="nav-label">{entry.name}</span>
          </NavLink>
        );
      })}
    </div>
  );
}

/**
 * The top bar's `⋯`, and what it lists.
 *
 * designs/shell-and-navigation.md § Disclosure and Commands says the top bar holds no verbs, and it still does not:
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
  null,
  "settings",
  "all-graphs",
];

function OverflowMenu({
  commands,
  bindings,
  onOpenPalette,
}: {
  commands: PaletteCommand[];
  bindings: Record<ShortcutId, Binding>;
  onOpenPalette: () => void;
}) {
  const { message } = useI18n();
  const byId = new Map(commands.map((command) => [command.id, command]));

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" aria-label={message("shell.moreActions")} data-testid="overflow-menu">
          <MoreHorizontalIcon aria-hidden />
        </Button>
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
  remote,
  onManageMembers,
  onExit,
}: {
  graphId: string;
  name: string;
  remote: boolean;
  onManageMembers: () => void;
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
        <Input
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
          <span className="rail-avatar" aria-hidden>
            {[...name.trim()][0] ?? "·"}
          </span>
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
        {remote && (
          <DropdownMenuItem onSelect={onManageMembers}>
            {message("graph.manageMembers")}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onExit}>{message("graph.allGraphs")}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
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
    <div className="shell-loading" role="status" aria-busy="true">
      {show && (
        <>
          <Loader2Icon className="spinner" aria-hidden />
          <p>{message("graph.loading")}</p>
        </>
      )}
    </div>
  );
}
