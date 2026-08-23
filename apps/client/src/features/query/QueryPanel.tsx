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
// **A surface need not own the document it reads.** A journal's standing question
// is written in Settings and lives in the browser, so it reaches here with no
// owner at all: the answer, its order, and its verbs are the reader's, and every
// edit that would change the *question* stops at the one write path below. What
// stays writable is the graph — a result row is still the block it quotes.
//
// The surface owns its authoring and presentation state. The answer itself has a
// graph-session lifetime: leaving the route or virtualizing the row that holds it
// must not turn a result back into an empty first frame when it returns.

import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
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
import type { Command, QueryOwnerRef } from "../../core-port/commands";
import type {
  OutlineOwner,
  PropertyDocument,
  QueryView,
  QueryViewColumn,
  QueryViewKind,
  QueryViewOptions,
  QueryViewSort,
} from "../../core-port/snapshot";
import { findOutline, outlineOwnerKey } from "../../core-port/snapshot";
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
import { compilePlan, planBindings, QUERY_LANGUAGE } from "../../entities/query-compile";
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
import { diffSplice } from "../blocks/editor/text-diff";
import { QueryBuilder } from "./QueryBuilder";
import { QueryListView } from "./QueryListView";
import { QuerySortControl } from "./QuerySortControl";
import { QueryTableView } from "./QueryTableView";
import { QueryViewTabs } from "./QueryViewTabs";
import { resultViewRows, type CellContext, type ResultColumn, type ResultRow } from "./cells";
import { QueryEditPortals, useQueryResultEditor } from "./edit";
import { useQueryAnswer } from "./execution";
import { answerLabel, columnLabel } from "./labels";
import { orderResultRows } from "./ordering";
import {
  queryResultsAreOpen,
  rememberQueryResultsOpen,
} from "./presentation";
import { planSummary, summaryLabel, type QuerySummary } from "./summary";

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
const PLAN_SAVE_DEBOUNCE_MS = 600;

const defaultOptions = (): QueryViewOptions => ({ compact: false, wrap: false, sort: [] });

/**
 * The one view every query document is born with, mirrored here so a surface
 * whose document has not been written yet shows the same answer it will have the
 * moment anybody shapes it. The id matches the core's, so the seed and the stored
 * document are the same view rather than look-alikes.
 *
 * It is named for what it shows, not for how it is drawn. A document used to be
 * born with a `Table` and a `List` holding the same rows under two names for
 * their own shapes — two tabs that were not two answers. Layout is a property of
 * a view; a second view is what a reader makes when they mean a second question.
 */
const SEED_VIEWS: QueryView[] = [
  { id: "all", name: "All", kind: "table", position: 0, columns: [], options: defaultOptions() },
];

export interface QueryPanelProps {
  /**
   * Where the document is written — `null` when it is not written here. Stated
   * rather than optional, so a new surface has to answer the question.
   */
  owner: QueryOwnerRef | null;
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
  variant: "inline" | "page";
  /** The section's accessible name. */
  label: string;
  /**
   * The name the reader gave this query, when they gave it one. It takes the
   * caption's lead and the plan keeps the qualifier, so `Scheduled · Deadline is
   * before tomorrow` is one sentence about one question.
   */
  caption?: string;
  /** Rows this surface's host adds to the actions menu, above its own verbs. */
  actions?: ReactNode;
  /** The block's own `Remove query`. A tag's query is part of the tag. */
  onRemove?: () => void;
}

export function QueryPanel({
  owner,
  executionKey,
  document,
  seedPlan,
  variant,
  label,
  caption,
  actions,
  onRemove,
}: QueryPanelProps) {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const history = useHistoryActions();
  const { message, formatJournalDate, compare } = useI18n();
  const readonly = state.mode === "readonly";
  /** Whether the document is this surface's to show — an editor to open at all. */
  const hosted = owner !== null;
  /** …and whether it is this surface's to change. */
  const writable = hosted && !readonly;
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
  const [editing, setEditing] = useState(
    () => owner !== null && unwritten(storedPlan ?? seedPlan ?? null, source),
  );
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
  const outputId = useId();
  const [resultsOpen, setResultsOpen] = useState(
    () => queryResultsAreOpen(session, executionKey),
  );
  const request = useMemo(() => ({
    language: document?.language ?? QUERY_LANGUAGE,
    source: runSource,
    bindings: runBindings,
  }), [document?.language, runBindings, runSource]);
  const { result, error, loading, run } = useQueryAnswer(executionKey, request);

  /**
   * The document's one write path, and the one place a surface that does not own
   * it stops. A journal's standing question is read here and written in Settings,
   * so every command below is a no-op for it rather than a guard repeated at nine
   * call sites — and a read-only graph is refused in the same place.
   */
  const write = (command: (target: QueryOwnerRef) => Command): Promise<void> =>
    owner && !readonly
      ? session.execute(command(owner)).then(() => undefined)
      : Promise.resolve();

  // One command per pause in the editing, never one per keystroke — and never
  // one at all for a seed nobody has touched, which is what lets a tag page be
  // opened, read, and left without writing anything.
  useEffect(() => {
    if (!plan || !compiled || !writable || !shaped.current) return;
    const payload = encodePlan(plan);
    if (payload === storedPayload) return;
    const timer = window.setTimeout(() => {
      void write((target) => ({
        type: "set_query_plan",
        owner: target,
        plan: { version: QUERY_PLAN_VERSION, payload },
        source: compiled.source,
      })).catch((cause: unknown) => notify.failure(message("failure.saveQuery"), cause));
    }, PLAN_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plan, compiled, storedPayload, writable, session]);

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
  const preferredViewId = (writable ? null : localViewId)
    ?? document?.default_view_id
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
  const resultBlockOwners = useMemo(
    () => [...new Map(resultRows.flatMap((row) => {
      if (row.subject?.kind !== "block") return [];
      const owner: OutlineOwner = row.subject.owner;
      return [[outlineOwnerKey(owner), owner] as const];
    })).values()].sort((left, right) => outlineOwnerKey(left).localeCompare(outlineOwnerKey(right))),
    [resultRows],
  );

  // A list of blocks is an entity projection, not a set of RDF cells. Resolve
  // its canonical display snapshots by page so the shared block presentation
  // sees the same markdown, task marks, tags, and property bag as the outline.
  // Table and non-block results stay query-shaped and pay no hydration cost.
  useEffect(() => {
    if (activeView.kind !== "list" || state.status !== "ready") return;
    const missing = resultBlockOwners.filter(
      (owner) => !state.hydratedOutlines.has(outlineOwnerKey(owner))
        && findOutline(state.snapshot, owner) !== undefined,
    );
    if (missing.length === 0) return;
    void session.hydrateOutlines(missing).catch((cause: unknown) => {
      notify.failure(message("failure.loadPage"), cause);
    });
  }, [
    activeView.kind,
    message,
    notify,
    resultBlockOwners,
    session,
    state.hydratedOutlines,
    state.snapshot,
    state.status,
  ]);
  const sorts = useMemo(() => {
    const stored = writable ? (activeView.options.sort ?? []) : localSorts;
    const orderableVariables = new Set(
      columns.filter((column) => column.sortable).map((column) => column.variable),
    );
    return stored.filter((sort) => orderableVariables.has(sort.variable));
  }, [activeView.options.sort, columns, localSorts, writable]);
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
  // the builder keystroke for keystroke and is already true when it closes. A name
  // the reader typed takes the lead and leaves the plan its qualifier: `Scheduled`
  // is what they call this question, `Deadline is before tomorrow` is what it asks.
  const summary = useMemo<QuerySummary>(
    () => {
      const derived = plan
        ? planSummary(plan, { snapshot: state.snapshot, message, formatDate: formatJournalDate })
        : { lead: "SPARQL", detail: null };
      return caption ? { lead: caption, detail: derived.detail } : derived;
    },
    [caption, plan, state.snapshot, message, formatJournalDate],
  );

  if (!document && !seedPlan) return null;

  const report = (cause: unknown) => notify.failure(message("failure.saveQuery"), cause);

  const commitSource = async () => {
    const splice = diffSplice(source, draft);
    if (!splice) return;
    await write((target) => ({ type: "splice_query_source", owner: target, ...splice }))
      .catch(report);
  };

  /**
   * A seeded query becomes a written one the moment somebody shapes it. Every
   * write below goes through here first, so the view commands — which edit a
   * document rather than create one — always find one.
   */
  const materialize = async () => {
    if (document || !plan || !compiled) return;
    shaped.current = true;
    await write((target) => ({
      type: "set_query_plan",
      owner: target,
      plan: { version: QUERY_PLAN_VERSION, payload: encodePlan(plan) },
      source: compiled.source,
    }));
  };

  const selectView = (viewId: string) => {
    if (viewId === activeView.id) return;
    if (!writable) {
      setLocalViewId(viewId);
      return;
    }
    void (async () => {
      await materialize();
      await write((target) => ({ type: "set_query_default_view", owner: target, view_id: viewId }));
    })().catch(report);
  };

  const putView = async (next: QueryView): Promise<boolean> => {
    try {
      await materialize();
      await write((target) => ({ type: "put_query_view", owner: target, view: next }));
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
      views.map((view) => view.name),
    );
    const position = views.reduce((highest, view) => Math.max(highest, view.position), -1) + 1;
    void (async () => {
      await materialize();
      await write((target) => ({
        type: "put_query_view",
        owner: target,
        view: { id, name, kind, position, columns: [], options: defaultOptions() },
      }));
      await write((target) => ({ type: "set_query_default_view", owner: target, view_id: id }));
    })().catch(report);
  };

  const duplicateView = (view: QueryView) => {
    const id = `v-${crypto.randomUUID()}`;
    const name = nextAvailableEntityName(
      view.name,
      views.map((item) => item.name),
    );
    const position = views.reduce((highest, item) => Math.max(highest, item.position), -1) + 1;
    void (async () => {
      await materialize();
      await write((target) => ({
        type: "put_query_view",
        owner: target,
        view: { ...view, id, name, position },
      }));
      await write((target) => ({ type: "set_query_default_view", owner: target, view_id: id }));
    })().catch(report);
  };

  const renameView = (view: QueryView, name: string) => {
    const next = name.trim();
    if (!next || next === view.name) return;
    const taken = views.some(
      (item) => item.id !== view.id
        && canonicalEntityName(item.name) === canonicalEntityName(next),
    );
    const unique = taken
      ? nextAvailableEntityName(next, views.map((item) => item.name))
      : next;
    void putView({ ...view, name: unique });
  };

  const removeView = (view: QueryView) => {
    if (views.length <= 1) return;
    void (async () => {
      await materialize();
      await write((target) => ({ type: "remove_query_view", owner: target, view_id: view.id }));
    })().catch(report);
  };

  /**
   * Views carry positions rather than an array order, so the strip hands back the
   * order it now reads in and this writes the positions that produce it — only
   * for the views whose place actually changed, which for a drag past one
   * neighbour is two of them.
   */
  const reorderViews = (next: QueryView[]) => {
    void (async () => {
      await materialize();
      await Promise.all(next.flatMap((view, position) => (
        view.position === position
          ? []
          : [write((target) => ({ type: "put_query_view", owner: target, view: { ...view, position } }))]
      )));
    })().catch(report);
  };

  /** The same move from the keyboard: one step, expressed as the whole order. */
  const moveView = (view: QueryView, delta: -1 | 1) => {
    const index = views.findIndex((item) => item.id === view.id);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= views.length) return;
    const next = [...views];
    [next[index], next[target]] = [next[target], next[index]];
    reorderViews(next);
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
    if (writable) void putView({ ...activeView, options: { ...activeView.options, sort: next } });
    else setLocalSorts(next);
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

  /**
   * The running order the header just handed back. A column the view has never
   * met keeps the record the table gave it, so dragging one never drops the width
   * or the visibility of any of them.
   */
  const reorderColumns = (order: string[]) => {
    const known = new Map(
      viewColumnOrder(activeView, columns).map((column) => [column.variable, column]),
    );
    const next = order.flatMap((variable) => {
      const column = known.get(variable);
      return column ? [column] : [];
    });
    const rest = [...known.values()].filter((column) => !order.includes(column.variable));
    void putView({ ...activeView, columns: [...next, ...rest] });
  };

  const setOption = (patch: Partial<QueryView["options"]>) =>
    putView({ ...activeView, options: { ...activeView.options, ...patch } });

  const resultLabel = answerLabel({ result, error, loading, run }, visibleRows.length, message);
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
      {/* A document born with one view has nothing to switch between, and a
          radio group of one is a statement dressed as a choice. The switcher
          appears when a second view does. */}
      {!tabbed && views.length > 1 && (
        <>
          <DropdownMenuLabel>{message("query.view")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={activeView.id} onValueChange={selectView}>
            {views.map((view) => (
              <DropdownMenuRadioItem key={view.id} value={view.id}>
                {view.name}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
        </>
      )}
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
          onReorder={reorderViews}
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
            (§ Disclosure) and the reason the two menus may be revealed.

            Where the document is not this surface's, the same phrase is a caption
            and only that — no chevron, nothing to press. A control that opens an
            editor for a question written somewhere else would be a promise the
            surface cannot keep; the route to the editor is a row in the `⋯` menu,
            named after the place it goes. */}
        {hosted ? (
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
        ) : (
          <span className="query-summary" data-static data-testid="query-summary">
            <span className="query-summary-lead">{summary.lead}</span>
            {summary.detail && (
              <span className="query-summary-detail">{summary.detail}</span>
            )}
          </span>
        )}

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
          {/* Everything in it writes the document, so it is absent where the
              document is not writable rather than parked there disabled: § Do /
              Don't keeps a control that cannot act off the surface. The one thing
              a reader may still change — the order — is its own control, and it
              keeps its own local answer. */}
          {!tabbed && writable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                {/* The header controls are the bespoke 24px icon-btn, not a shadcn
                    Button: its size utilities live in the `utilities` layer, which
                    outranks `neoseq`, so no header CSS could ever size them. */}
                <button
                  type="button"
                  className="icon-btn"
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
              {/* The host's own rows come first: where this surface only reads the
                  document, the route to the place that writes it is the verb the
                  reader came to the menu for. */}
              {actions}
              {/* In source mode the SPARQL is already the editor, so there is
                  nothing to disclose — unless the editor is somewhere else, and
                  then this is the only way to read what actually runs. */}
              {(plan || !hosted) && (
                <>
                  {actions && <DropdownMenuSeparator />}
                  <DropdownMenuItem onSelect={() => setShowSource((open) => !open)}>
                    <CodeIcon aria-hidden />
                    {showSource ? message("query.hideSource") : message("query.showSource")}
                  </DropdownMenuItem>
                </>
              )}
              {onRemove && (
                <>
                  <DropdownMenuSeparator />
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
          readOnly={!writable}
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

      {/* What actually runs: the plan's compilation, or the hand-written source
          of a query whose editor is not on this surface. */}
      {showSource && (
        <pre className="query-compiled" data-testid="query-compiled">
          <code>{runSource}</code>
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
            onResize={writable
              ? (variable, width) => setColumn(variable, { width: width || null })
              : undefined}
            onHide={writable ? (variable) => setColumn(variable, { hidden: true }) : undefined}
            onMove={writable ? moveColumn : undefined}
            onReorder={writable ? reorderColumns : undefined}
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
