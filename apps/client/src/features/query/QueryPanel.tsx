// A query, and the answer it stands for.
//
// Two ways to say the same thing. The **builder** is the default and the only
// one `/` creates: a plan, compiled here into the SPARQL the core runs, with
// every user value travelling as a bound parameter so "due today" stays true
// tomorrow. **Source** is the escape hatch — hand-written SPARQL, which detaches
// the plan because the builder no longer describes what runs.
//
// **The answer is the object; the question is a disclosure.** At rest a query is
// one caption line and its result — the plan read back as a phrase, how much it
// found, and nothing else. The editor that wrote the phrase opens from the phrase
// itself, so the five rows of authoring that used to sit permanently above every
// answer are there when someone is authoring and absent when nobody is.
//
// **One surface, two grounds.** Embedded in the outline (`inline`) a query is a
// paragraph that answers itself, so its views live in a menu and its chrome waits
// for a pointer. Given a page of its own (`page`) the query *is* the page, so its
// views become a permanent tab strip and each one is a thing the reader names,
// arranges, and deletes. The document underneath is identical; only how much of
// it the surface is allowed to state permanently differs.
//
// The surface owns its authoring and presentation state. The answer itself has a
// graph-session lifetime: leaving the route or virtualizing the row that holds it
// must not turn a result back into an empty first frame when it returns.

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  ListIcon,
  MoreHorizontalIcon,
  Table2Icon,
  Trash2Icon,
} from "lucide-react";
import type { QueryEntityRef } from "../../generated/core-port";
import type { PropertyOwnerRef } from "../../core-port/commands";
import type {
  PropertyDocument,
  QueryView,
  QueryViewColumn,
  QueryViewKind,
  QueryViewOptions,
  QueryViewSort,
} from "../../core-port/snapshot";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { todayLocalDate } from "../../entities/journal";
import { canonicalEntityName, nextAvailableEntityName } from "../../entities/names";
import { compilePlan, planBindings } from "../../entities/query-compile";
import {
  inferOrderSemantics,
  orderSemanticsForColumn,
} from "../../entities/query-ordering";
import {
  columnVariable,
  decodePlan,
  encodePlan,
  QUERY_PLAN_VERSION,
  type PlanColumn,
  type QueryPlan,
} from "../../entities/query-plan";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { useHistoryActions } from "../history/context";
import { useI18n } from "../../i18n";
import { failureReason } from "../notify/errors";
import { diffSplice } from "../blocks/editor/text-diff";
import { QueryBuilder } from "./QueryBuilder";
import { QueryListView } from "./QueryListView";
import { QuerySortControl } from "./QuerySortControl";
import { QueryTableView } from "./QueryTableView";
import { QueryViewTabs } from "./QueryViewTabs";
import { resultViewRows, type CellContext, type ResultColumn, type ResultRow } from "./cells";
import { QueryEditPortals, useQueryResultEditor } from "./edit";
import {
  queryExecutionSignature,
  queryExecutionStore,
  useQueryExecution,
} from "./execution";
import { columnLabel, viewLabel } from "./labels";
import { orderResultRows } from "./ordering";
import {
  queryResultsAreOpen,
  rememberQueryResultsOpen,
} from "./presentation";
import { planSummary, summaryLabel, type QuerySummary } from "./summary";

const LANGUAGE = "sparql-1.1/neoseq-v1" as const;

/**
 * What an empty SPARQL editor shows instead of a blank box: the shape of the one
 * query everything else is a variation on. It is not localized, because SPARQL is
 * not a language anyone reads in their own — and it is a placeholder rather than
 * a prefilled source, so `/ Advanced query` lands on an editor waiting for the
 * person who asked for it rather than on a result they did not write.
 */
const SOURCE_PLACEHOLDER = `PREFIX neo: <urn:neoseq:vocab:v1:>

SELECT ?block ?text WHERE {
  ?block a neo:Block ;
         neo:content ?text .
}
LIMIT 100`;
const RUN_DEBOUNCE_MS = 300;
const PLAN_SAVE_DEBOUNCE_MS = 600;

const defaultOptions = (): QueryViewOptions => ({ compact: false, wrap: false, sort: [] });

/**
 * The two views every query document is born with, mirrored here so a surface
 * whose document has not been written yet still shows the same two answers it
 * will have the moment anybody shapes it. The ids match the core's, so the seed
 * and the stored document are the same views rather than look-alikes.
 */
const SEED_VIEWS: QueryView[] = [
  { id: "table", name: "Table", kind: "table", position: 0, columns: [], options: defaultOptions() },
  { id: "list", name: "List", kind: "list", position: 1, columns: [], options: defaultOptions() },
];

export interface QueryPanelProps {
  /** Where the document is written. */
  owner: PropertyOwnerRef;
  /** Stable identity for the cached answer — one per surface, not per render. */
  executionKey: string;
  /** The stored document, or `undefined` while the surface is still only a seed. */
  document: PropertyDocument | undefined;
  /**
   * What the surface asks before anyone has shaped it. A seeded surface is a
   * *promise* rather than a write: reading a tag never touches the graph, and the
   * first edit is what brings the document into existence.
   */
  seedPlan?: QueryPlan;
  /**
   * Which of the seeded views a surface opens on before it has a document. The
   * core's own default is the table; a surface whose answer is a set of blocks
   * rather than a set of cells says so here.
   */
  seedViewId?: string;
  variant: "inline" | "page";
  /** The section's accessible name. */
  label: string;
  /** The block's own `Remove query`. A tag's query is part of the tag. */
  onRemove?: () => void;
}

export function QueryPanel({
  owner,
  executionKey,
  document,
  seedPlan,
  seedViewId,
  variant,
  label,
  onRemove,
}: QueryPanelProps) {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const history = useHistoryActions();
  const { message, formatJournalDate, compare } = useI18n();
  const readonly = state.mode === "readonly";
  const tabbed = variant === "page";

  const source = document?.source ?? "";
  const storedPlan = useMemo(
    () => (document?.plan ? decodePlan(document.plan.payload, document.plan.version) : null),
    [document?.plan],
  );
  const storedPayload = storedPlan ? encodePlan(storedPlan) : null;

  const [plan, setPlan] = useState<QueryPlan | null>(storedPlan ?? seedPlan ?? null);
  const [draft, setDraft] = useState(source);
  // The editor opens for a query that has not been written yet and stays shut for
  // one that has: a query with no conditions has nothing to say in its caption, so
  // showing it the builder is the only honest first screen. Once a reader has
  // shaped it, reopening the page shows them the answer they shaped it for. Which
  // it is, is theirs from the first press — never re-derived under their hands.
  const [editing, setEditing] = useState(() => unwritten(storedPlan ?? seedPlan ?? null, source));
  const [showSource, setShowSource] = useState(false);
  // Reading is never read-only. Without a document to write the order into, it
  // lives here for as long as the surface is mounted — and it has to live *here*
  // rather than in the table, because the header's sort panel edits the same
  // list the header row does.
  const [localSorts, setLocalSorts] = useState<QueryViewSort[]>([]);
  // Which view a reader who may not write is looking at. A writable graph keeps
  // that answer in the document, where every replica reads it.
  const [localViewId, setLocalViewId] = useState<string | null>(null);
  // Nobody has shaped this query yet, so nothing is written for it yet. The flag
  // is what keeps merely *visiting* a seeded surface out of the graph's history.
  const shaped = useRef(document !== undefined);
  if (document !== undefined) shaped.current = true;
  // The authoritative document is the truth after a remote edit or a reload;
  // the local draft is the truth while the reader is typing into it.
  useEffect(() => setDraft(source), [source]);
  useEffect(() => setPlan(storedPlan ?? seedPlan ?? null), [storedPayload]); // eslint-disable-line react-hooks/exhaustive-deps

  const compiled = useMemo(() => (plan ? compilePlan(plan) : null), [plan]);
  const runtime = useMemo(
    () => ({ graphId: state.snapshot.graph_id, today: todayLocalDate() }),
    [state.snapshot.graph_id],
  );
  // A built query runs from the plan in hand, so a result follows an edit
  // without waiting for the write that persists it.
  const runSource = compiled ? compiled.source : draft;
  const runBindings = useMemo(
    () => (compiled ? planBindings(compiled.parameters, runtime) : {}),
    [compiled, runtime],
  );
  const executionStore = queryExecutionStore(session);
  const outputId = useId();
  const [resultsOpen, setResultsOpen] = useState(
    () => queryResultsAreOpen(session, executionKey),
  );
  const executionRequest = useMemo(() => ({
    language: document?.language ?? LANGUAGE,
    source: runSource,
    bindings: runBindings,
  }), [document?.language, runBindings, runSource]);
  const executionSignature = useMemo(
    () => queryExecutionSignature(executionRequest),
    [executionRequest],
  );
  const execution = useQueryExecution(
    executionStore,
    executionKey,
    executionSignature,
    state.canonicalRevision,
  );
  const executable = runSource.trim().length > 0;
  const result = executable ? execution.result : null;
  const error = executable && execution.error !== null
    ? failureReason(execution.error, message)
    : null;
  const loading = executable && execution.loading;
  const run = useCallback((force = false) => {
    // A blank source is a query the user has not written yet, not a parse
    // failure — it stays quietly at "not run" instead of opening on an error.
    if (!executable) {
      executionStore.clear(executionKey);
      return;
    }
    void executionStore.run(
      executionKey,
      executionSignature,
      state.canonicalRevision,
      executionRequest,
      { force },
    );
  }, [
    executable,
    executionKey,
    executionRequest,
    executionSignature,
    executionStore,
    state.canonicalRevision,
  ]);
  const previousExecution = useRef<{ owner: string; identity: string } | null>(null);

  useEffect(() => {
    const identity = JSON.stringify([executionSignature, state.canonicalRevision]);
    const previous = previousExecution.current;
    previousExecution.current = { owner: executionKey, identity };
    if (!executable) {
      executionStore.clear(executionKey);
      return;
    }
    // Activation is a demand read: a fresh cached answer renders synchronously,
    // while a missing or stale one starts immediately. Only a change observed by
    // an already-mounted query is a stream worth coalescing.
    if (!previous || previous.owner !== executionKey) {
      run();
      return;
    }
    // StrictMode repeats an effect setup without changing its input. The store
    // also deduplicates in-flight work, but avoiding the timer makes the intent
    // explicit and keeps a failed activation from becoming an automatic retry.
    if (previous.identity === identity) return;
    const timer = window.setTimeout(run, RUN_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    executable,
    executionKey,
    executionSignature,
    executionStore,
    run,
    state.canonicalRevision,
  ]);

  // One command per pause in the editing, never one per keystroke — and never
  // one at all for a seed nobody has touched, which is what lets a tag page be
  // opened, read, and left without writing anything.
  useEffect(() => {
    if (!plan || !compiled || readonly || !shaped.current) return;
    const payload = encodePlan(plan);
    if (payload === storedPayload) return;
    const timer = window.setTimeout(() => {
      void session
        .execute({
          type: "set_query_plan",
          owner,
          plan: { version: QUERY_PLAN_VERSION, payload },
          source: compiled.source,
        })
        .catch((cause: unknown) => notify.failure(message("failure.saveQuery"), cause));
    }, PLAN_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, compiled, storedPayload, readonly, session]);

  // Both derived once, not once per render: a canonical revision re-renders every
  // mounted query, and the table rebuilds its column models whenever either of
  // these changes identity.
  const cellContext = useMemo<CellContext>(() => ({
    snapshot: state.snapshot,
    subjectVariable: compiled?.subjectVariable ?? null,
    message,
    formatDate: formatJournalDate,
    compare,
    onOpen: (entity: QueryEntityRef) => {
      history.open(entity);
    },
  }), [state.snapshot, compiled?.subjectVariable, message, formatJournalDate, compare, history]);

  const resultEditor = useQueryResultEditor({
    session,
    state,
    enabled: Boolean(plan && compiled?.subjectVariable) && !readonly,
    message,
  });

  const views = document?.views ?? SEED_VIEWS;
  const preferredViewId = (readonly ? localViewId : null)
    ?? document?.default_view_id
    ?? seedViewId
    ?? views[0].id;
  const activeView = views.find((view) => view.id === preferredViewId) ?? views[0];

  const select = result?.kind === "select" ? result : null;
  const columns = useMemo(
    () => (select
      ? resultColumns(select, plan, activeView, message, compiled?.subjectVariable)
      : []),
    [select, activeView, plan, message, compiled?.subjectVariable],
  );
  const resultRows = useMemo(
    () => resultViewRows((select?.rows ?? []) as ResultRow[], cellContext),
    [select, cellContext],
  );
  const resultBlockPageIds = useMemo(
    () => [...new Set(resultRows.flatMap((row) =>
      row.subject?.kind === "block" ? [row.subject.page_id] : [],
    ))].sort(),
    [resultRows],
  );

  // A list of blocks is an entity projection, not a set of RDF cells. Resolve
  // its canonical display snapshots by page so the shared block presentation
  // sees the same markdown, task marks, tags, and property bag as the outline.
  // Table and non-block results stay query-shaped and pay no hydration cost.
  useEffect(() => {
    if (activeView.kind !== "list" || state.status !== "ready") return;
    const missing = resultBlockPageIds.filter(
      (pageId) => !state.hydratedPages.has(pageId)
        && state.snapshot.pages.some((page) => page.id === pageId),
    );
    if (missing.length === 0) return;
    void session.hydratePages(missing).catch((cause: unknown) => {
      notify.failure(message("failure.loadPage"), cause);
    });
  }, [
    activeView.kind,
    message,
    notify,
    resultBlockPageIds,
    session,
    state.hydratedPages,
    state.snapshot.pages,
    state.status,
  ]);
  const sorts = useMemo(() => {
    const stored = readonly ? localSorts : (activeView.options.sort ?? []);
    const orderableVariables = new Set(
      columns.filter((column) => column.sortable).map((column) => column.variable),
    );
    return stored.filter((sort) => orderableVariables.has(sort.variable));
  }, [activeView.options.sort, columns, localSorts, readonly]);
  const activeOrigin = resultEditor.active?.origin.row;
  const activeRowPresent = activeOrigin
    ? resultRows.some((row) => row.key === activeOrigin.key)
    : true;
  const pinnedRow = activeOrigin && !activeRowPresent ? activeOrigin : null;
  const visibleRows = useMemo(
    () => orderResultRows(
      pinnedRow ? [...resultRows, pinnedRow] : resultRows,
      sorts,
      columns,
      cellContext,
    ),
    [cellContext, columns, pinnedRow, resultRows, sorts],
  );

  // The caption follows the plan in hand, not the saved one, so the phrase tracks
  // the builder keystroke for keystroke and is already true when it closes.
  const summary = useMemo<QuerySummary>(
    () => (plan
      ? planSummary(plan, { snapshot: state.snapshot, message, formatDate: formatJournalDate })
      : { lead: "SPARQL", detail: null }),
    [plan, state.snapshot, message, formatJournalDate],
  );

  if (!document && !seedPlan) return null;

  const report = (cause: unknown) => notify.failure(message("failure.saveQuery"), cause);

  const commitSource = async () => {
    const splice = diffSplice(source, draft);
    if (!splice) return;
    await session.execute({ type: "splice_query_source", owner, ...splice }).catch(report);
  };

  /**
   * A seeded query becomes a written one the moment somebody shapes it. Every
   * write below goes through here first, so the view commands — which edit a
   * document rather than create one — always find one.
   */
  const materialize = async () => {
    if (document || !plan || !compiled) return;
    shaped.current = true;
    await session.execute({
      type: "set_query_plan",
      owner,
      plan: { version: QUERY_PLAN_VERSION, payload: encodePlan(plan) },
      source: compiled.source,
    });
    // A fresh document opens on the core's default view — the first seeded one.
    // The reader was already looking at another one, so the document is written
    // to agree with the screen rather than the screen with the document.
    if (activeView.id !== SEED_VIEWS[0].id) {
      await session.execute({
        type: "set_query_default_view",
        owner,
        view_id: activeView.id,
      });
    }
  };

  const selectView = (viewId: string) => {
    if (viewId === activeView.id) return;
    if (readonly) {
      setLocalViewId(viewId);
      return;
    }
    void (async () => {
      await materialize();
      await session.execute({ type: "set_query_default_view", owner, view_id: viewId });
    })().catch(report);
  };

  const putView = async (next: QueryView): Promise<boolean> => {
    try {
      await materialize();
      await session.execute({ type: "put_query_view", owner, view: next });
      return true;
    } catch (cause) {
      report(cause);
      return false;
    }
  };

  /** A new view opens on itself: adding one and not landing on it says nothing. */
  const addView = (kind: QueryViewKind) => {
    const id = `v-${crypto.randomUUID()}`;
    const name = nextAvailableEntityName(
      message(kind === "table" ? "query.viewTable" : "query.viewList"),
      views.map((view) => viewLabel(view, message)),
    );
    const position = views.reduce((highest, view) => Math.max(highest, view.position), -1) + 1;
    void (async () => {
      await materialize();
      await session.execute({
        type: "put_query_view",
        owner,
        view: { id, name, kind, position, columns: [], options: defaultOptions() },
      });
      await session.execute({ type: "set_query_default_view", owner, view_id: id });
    })().catch(report);
  };

  const duplicateView = (view: QueryView) => {
    const id = `v-${crypto.randomUUID()}`;
    const name = nextAvailableEntityName(
      viewLabel(view, message),
      views.map((item) => viewLabel(item, message)),
    );
    const position = views.reduce((highest, item) => Math.max(highest, item.position), -1) + 1;
    void (async () => {
      await materialize();
      await session.execute({
        type: "put_query_view",
        owner,
        view: { ...view, id, name, position },
      });
      await session.execute({ type: "set_query_default_view", owner, view_id: id });
    })().catch(report);
  };

  const renameView = (view: QueryView, name: string) => {
    const next = name.trim();
    if (!next || next === viewLabel(view, message)) return;
    const taken = views.some(
      (item) => item.id !== view.id
        && canonicalEntityName(viewLabel(item, message)) === canonicalEntityName(next),
    );
    void putView({ ...view, name: taken ? nextAvailableEntityName(next, views.map((item) => viewLabel(item, message))) : next });
  };

  const removeView = (view: QueryView) => {
    if (views.length <= 1) return;
    void (async () => {
      await materialize();
      await session.execute({ type: "remove_query_view", owner, view_id: view.id });
    })().catch(report);
  };

  /**
   * Views carry positions rather than an array order, so a move is a swap of the
   * two positions. Writing both keeps the strip in the order the reader sees even
   * when a peer has been rearranging it at the same time.
   */
  const moveView = (view: QueryView, delta: -1 | 1) => {
    const index = views.findIndex((item) => item.id === view.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= views.length) return;
    const neighbour = views[target];
    void (async () => {
      await materialize();
      await session.execute({
        type: "put_query_view",
        owner,
        view: { ...view, position: neighbour.position },
      });
      await session.execute({
        type: "put_query_view",
        owner,
        view: { ...neighbour, position: view.position },
      });
    })().catch(report);
  };

  const hidden = new Set(
    activeView.columns.filter((column) => column.hidden).map((column) => column.variable),
  );
  const visible = columns.filter((column) => !hidden.has(column.variable));

  // The first layout change writes the whole running order, so later ones have
  // a list to patch rather than a partial one to merge into.
  const setColumn = (variable: string, patch: Partial<QueryViewColumn>) => {
    const base = viewColumnOrder(activeView, columns);
    const next = base.some((column) => column.variable === variable)
      ? base.map((column) => (column.variable === variable ? { ...column, ...patch } : column))
      : [...base, { variable, hidden: false, width: null, ...patch }];
    return putView({ ...activeView, columns: dedupe(next) });
  };

  // A header click is one command, not a debounced stream: the reader clicked
  // once and expects the order to be theirs from then on.
  const setSorts = (next: QueryViewSort[]) => {
    if (readonly) setLocalSorts(next);
    else void putView({ ...activeView, options: { ...activeView.options, sort: next } });
  };

  const moveColumn = (variable: string, delta: -1 | 1) => {
    const order = viewColumnOrder(activeView, columns);
    const index = order.findIndex((column) => column.variable === variable);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    void putView({ ...activeView, columns: next });
  };

  const setOption = (patch: Partial<QueryView["options"]>) =>
    putView({ ...activeView, options: { ...activeView.options, ...patch } });

  const resultLabel = error
    ? message("query.failed")
    : select
      ? message("query.results", { count: visibleRows.length })
      : loading
        ? message("query.running")
        : result?.kind === "ask"
          ? message("query.answer")
          : null;
  const resultCanCollapse = Boolean(
    error
    || result?.kind === "ask"
    || (select && visibleRows.length > 0),
  );

  const toggleResults = async () => {
    const nextOpen = !resultsOpen;
    if (!nextOpen && resultEditor.active) {
      if (resultEditor.active.phase === "markdown") {
        if (!(await resultEditor.commit(true))) return;
      } else {
        resultEditor.cancel();
      }
    }
    rememberQueryResultsOpen(session, executionKey, nextOpen);
    setResultsOpen(nextOpen);
  };

  /* The switches that shape one view. In the outline they hang under the layout
     icon; on a page they are the tab's own menu, because there the tab *is* the
     view and a second control for it would be a second owner. */
  const layoutItems = (
    <>
      {tabbed && (
        <>
          <DropdownMenuLabel>{message("query.layout")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={activeView.kind}
            onValueChange={(kind) => void putView({ ...activeView, kind: kind as QueryViewKind })}
          >
            <DropdownMenuRadioItem value="table">
              {message("query.viewTable")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="list">
              {message("query.viewList")}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </>
      )}
      {!tabbed && (
        <>
          <DropdownMenuLabel>{message("query.view")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={activeView.id} onValueChange={selectView}>
            {views.map((view) => (
              <DropdownMenuRadioItem key={view.id} value={view.id}>
                {viewLabel(view, message)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </>
      )}
      {columns.length > 0 && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{message("query.columns")}</DropdownMenuLabel>
          {columns.map((column) => (
            <DropdownMenuCheckboxItem
              key={column.variable}
              checked={!hidden.has(column.variable)}
              disabled={!hidden.has(column.variable) && visible.length <= 1}
              onSelect={(event) => {
                event.preventDefault();
                void setColumn(column.variable, { hidden: !hidden.has(column.variable) });
              }}
            >
              {column.label}
            </DropdownMenuCheckboxItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuLabel>{message("query.rows")}</DropdownMenuLabel>
          {/* A checked switch says what is on. The label used to flip
              between `Compact rows` and `Roomy rows`, which left the
              reader guessing whether it named the state or the verb. */}
          <DropdownMenuCheckboxItem
            checked={activeView.options.compact}
            onSelect={(event) => {
              event.preventDefault();
              void setOption({ compact: !activeView.options.compact });
            }}
          >
            {message("query.densityCompact")}
          </DropdownMenuCheckboxItem>
          {activeView.kind === "table" && (
            <DropdownMenuCheckboxItem
              checked={activeView.options.wrap}
              onSelect={(event) => {
                event.preventDefault();
                void setOption({ wrap: !activeView.options.wrap });
              }}
            >
              {message("query.wrap")}
            </DropdownMenuCheckboxItem>
          )}
        </>
      )}
    </>
  );

  return (
    <section
      className="query-block"
      data-variant={variant}
      aria-label={label}
      data-testid="query-block"
      // Diagnostic, not chrome. Which index revision answered is the first thing
      // to know when a result looks stale and the last thing a reader of the
      // answer cares about, so it is written where a test or a console can read
      // it and the caption stays a sentence about the query.
      data-revision={result?.revision}
    >
      {tabbed && (
        <QueryViewTabs
          views={views}
          activeView={activeView}
          readonly={readonly}
          panelId={outputId}
          menu={layoutItems}
          onSelect={selectView}
          onAdd={addView}
          onRename={renameView}
          onDuplicate={duplicateView}
          onRemove={removeView}
          onMove={moveView}
        />
      )}
      <div className="query-header">
        {/* The sentence *is* the disclosure. A query whose caption reads
            `Blocks · Status is Done` needs no `Edit` button beside it: the phrase
            names the thing it opens, which is the one permanent pointer route in
            (§ Disclosure) and the reason the two menus may be revealed. */}
        <button
          type="button"
          className="query-summary"
          aria-expanded={editing}
          aria-label={summaryLabel(summary)}
          data-testid="query-summary"
          onClick={() => setEditing((open) => !open)}
        >
          {/* A swap, not a rotation: § Motion allows no transform animation on
              anything a pointer must hit or an audit must read. */}
          {editing ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
          <span className="query-summary-lead">{summary.lead}</span>
          {summary.detail && (
            <span className="query-summary-detail">{summary.detail}</span>
          )}
        </button>

        {/* How much it found — the one fact about a result that is not in the
            result. On the first run there is nothing to count yet and it says so;
            afterwards a rerun updates the number in place rather than flickering
            `running` over it on every debounced keystroke. */}
        {resultLabel && (resultCanCollapse ? (
          <button
            type="button"
            className="query-count query-results-toggle"
            aria-expanded={resultsOpen}
            aria-controls={outputId}
            aria-label={message(
              resultsOpen ? "query.collapseResults" : "query.expandResults",
              { result: resultLabel },
            )}
            aria-busy={loading || undefined}
            data-state={error ? "error" : loading ? "loading" : "success"}
            data-testid="query-count"
            onPointerDown={() => resultEditor.preserveDraftForPresentationChange()}
            onClick={() => void toggleResults()}
          >
            <span>{resultLabel}</span>
            {resultsOpen
              ? <ChevronDownIcon aria-hidden />
              : <ChevronRightIcon aria-hidden />}
          </button>
        ) : (
          <span className="query-count" data-testid="query-count" aria-busy={loading || undefined}>
            {resultLabel}
          </span>
        ))}

        <div className="query-header-actions">
          {/* Order comes before layout, because it is the one a reader changes
              while reading. It is only offered once there is something to order. */}
          {columns.some((column) => column.sortable) && (
            <QuerySortControl columns={visible} sorts={sorts} onChange={setSorts} />
          )}
          {!tabbed && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                {/* The header controls are the bespoke 24px icon-btn, not a shadcn
                    Button: its size utilities live in the `utilities` layer, which
                    outranks `neoseq`, so no header CSS could ever size them. */}
                <button
                  type="button"
                  className="icon-btn"
                  disabled={readonly}
                  // The menu is wider than the view it opens on, so the name is the
                  // whole question it answers, not just its first group.
                  aria-label={message("query.display")}
                  data-testid="query-view-trigger"
                  data-view={activeView.kind}
                  onPointerDown={() => resultEditor.preserveDraftForPresentationChange()}
                >
                  {activeView.kind === "table"
                    ? <Table2Icon aria-hidden />
                    : <ListIcon aria-hidden />}
                </button>
              </DropdownMenuTrigger>
              {/* One menu, because table-or-list, which columns, and how tall the
                  rows are answer one question: how this answer is laid out.

                  Every row in it is a **state**, so every row is checkable and
                  every label starts at the same left edge. Before this, the two
                  views were radio rows with icons and the switches below them were
                  plain rows with none — three left edges and two idioms in a menu
                  of eight lines, which is why Table and List looked like a
                  different kind of thing from everything under them. Verbs carry
                  icons (see the block's own `⋯`); states carry a check. */}
              <DropdownMenuContent align="end">{layoutItems}</DropdownMenuContent>
            </DropdownMenu>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="icon-btn"
                aria-label={message("query.actions")}
                data-testid="query-actions-trigger"
              >
                <MoreHorizontalIcon aria-hidden />
              </button>
            </DropdownMenuTrigger>
            {/* Verbs only. Running is not one — the query reruns on every edit
                and every canonical revision, so a `Run` row was a button for a
                thing that already happens. Neither is the index revision: it is
                a diagnostic, and `data-revision` is where a diagnostic goes. */}
            <DropdownMenuContent align="end">
              {/* In source mode the SPARQL is already the editor, so there is
                  nothing to disclose. */}
              {plan && (
                <DropdownMenuItem onSelect={() => setShowSource((open) => !open)}>
                  <CodeIcon aria-hidden />
                  {showSource ? message("query.hideSource") : message("query.showSource")}
                </DropdownMenuItem>
              )}
              {onRemove && (
                <>
                  {plan && <DropdownMenuSeparator />}
                  <DropdownMenuItem variant="destructive" disabled={readonly} onSelect={onRemove}>
                    <Trash2Icon aria-hidden />
                    {message("query.remove")}
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {editing && (plan ? (
        <QueryBuilder
          plan={plan}
          snapshot={state.snapshot}
          readonly={readonly}
          onChange={(next) => {
            shaped.current = true;
            setPlan(next);
          }}
        />
      ) : (
        <textarea
          className="query-source"
          value={draft}
          readOnly={readonly}
          spellCheck={false}
          placeholder={SOURCE_PLACEHOLDER}
          aria-label={message("query.source")}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitSource()}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              run(true);
            }
          }}
        />
      ))}

      {plan && showSource && (
        <pre className="query-compiled" data-testid="query-compiled">
          <code>{compiled?.source}</code>
        </pre>
      )}

      <div
        id={outputId}
        className="query-output"
        hidden={!resultsOpen}
        aria-busy={loading}
        data-testid="query-output"
      >
        {error && (
          <p className="query-diagnostic" role="alert">
            {error}
          </p>
        )}
        {!error && result?.kind === "ask" && (
          <p className="query-ask" data-value={result.value}>
            {result.value ? message("query.askTrue") : message("query.askFalse")}
          </p>
        )}
        {/* An empty answer needs no sentence of its own: the count in the header
            already says `No results`, and saying it twice is the redundancy this
            block was full of. */}
        {!error && select && visibleRows.length > 0 && activeView.kind === "table" && (
          <QueryTableView
            columns={inViewOrder(visible, activeView)}
            rows={visibleRows}
            context={cellContext}
            editor={resultEditor}
            pinnedRowKey={pinnedRow?.key}
            compact={activeView.options.compact}
            wrap={activeView.options.wrap}
            sorts={sorts}
            onSort={setSorts}
            onResize={readonly
              ? undefined
              : (variable, width) => setColumn(variable, { width: width || null })}
            onHide={readonly ? undefined : (variable) => setColumn(variable, { hidden: true })}
            onMove={readonly ? undefined : moveColumn}
          />
        )}
        {!error && select && visibleRows.length > 0 && activeView.kind === "list" && (
          <QueryListView
            columns={inViewOrder(visible, activeView)}
            rows={visibleRows}
            context={cellContext}
            editor={resultEditor}
            pinnedRowKey={pinnedRow?.key}
            compact={activeView.options.compact}
          />
        )}
      </div>
      <QueryEditPortals editor={resultEditor} />
    </section>
  );
}

/**
 * Whether nobody has said what this query looks for yet — which is the one case
 * where the answer is not the interesting part of the surface. A plan with no
 * conditions matches everything, and a blank source matches nothing; either way
 * the editor is what the reader came for.
 */
function unwritten(plan: QueryPlan | null, source: string): boolean {
  return plan ? plan.where.children.length === 0 : source.trim().length === 0;
}

/**
 * The result's columns, told apart by the plan that asked for them. A variable
 * the plan does not know — a hand-written query, or one the builder has since
 * changed — still gets a column, named after itself.
 */
function resultColumns(
  select: { variables: string[]; rows: ResultRow[] },
  plan: QueryPlan | null,
  view: QueryView,
  message: ReturnType<typeof useI18n>["message"],
  subjectVariable?: string | null,
): ResultColumn[] {
  const planned = new Map<string, PlanColumn>();
  if (plan) for (const column of plan.columns) planned.set(columnVariable(column), column);
  const widths = new Map(view.columns.map((column) => [column.variable, column.width]));
  // Row identity is carried, not shown: it is what a text cell links to.
  return select.variables.filter((variable) => variable !== subjectVariable).map((variable) => {
    const column = planned.get(variable);
    const ordering = column
      ? orderSemanticsForColumn(column)
      : inferOrderSemantics(select.rows.map((row) => row[variable]));
    return {
      variable,
      label: column && plan ? columnLabel(column, plan.subject, message) : `?${variable}`,
      source: column?.source,
      aggregate: column?.aggregate,
      ordering,
      sortable: ordering.kind !== "unsupported_list",
      numeric: ordering.kind === "number",
      width: widths.get(variable) ?? null,
    };
  });
}

/** The reader's order first; anything the view has never seen keeps its place. */
function inViewOrder(columns: ResultColumn[], view: QueryView): ResultColumn[] {
  if (view.columns.length === 0) return columns;
  const position = new Map(view.columns.map((column, index) => [column.variable, index]));
  return [...columns].sort((left, right) =>
    (position.get(left.variable) ?? Number.MAX_SAFE_INTEGER)
    - (position.get(right.variable) ?? Number.MAX_SAFE_INTEGER));
}

/** The view's running order, extended with any column it has not met yet. */
function viewColumnOrder(view: QueryView, columns: ResultColumn[]): QueryViewColumn[] {
  const known = new Set(view.columns.map((column) => column.variable));
  return [
    ...view.columns,
    ...columns
      .filter((column) => !known.has(column.variable))
      .map((column) => ({ variable: column.variable, hidden: false, width: column.width })),
  ];
}

function dedupe(columns: QueryViewColumn[]): QueryViewColumn[] {
  const seen = new Set<string>();
  return columns.filter((column) => {
    if (seen.has(column.variable)) return false;
    seen.add(column.variable);
    return true;
  });
}
