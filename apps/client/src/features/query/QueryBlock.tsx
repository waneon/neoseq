// A query, embedded in the outline.
//
// Two ways to say the same thing. The **builder** is the default and the only
// one `/` creates: a plan, compiled here into the SPARQL the core runs, with
// every user value travelling as a bound parameter so "due today" stays true
// tomorrow. **Source** is the escape hatch — hand-written SPARQL, which detaches
// the plan because the builder no longer describes what runs.
//
// **The answer is the block; the question is a disclosure.** At rest a query is
// one caption line and its result — the plan read back as a phrase, how much it
// found, and nothing else. The editor that wrote the phrase opens from the phrase
// itself, so the five rows of authoring that used to sit permanently above every
// answer are there when someone is authoring and absent when nobody is.
//
// The block owns its authoring and presentation state. The answer itself has a
// graph-session lifetime: leaving the route or virtualizing this row must not
// turn a result back into an empty first frame when it returns.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import type {
  BlockSnapshot,
  QueryView,
  QueryViewColumn,
  QueryViewSort,
} from "../../core-port/snapshot";
import { queryDocument } from "../../core-port/snapshot";
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
import { resultViewRows, type CellContext, type ResultColumn, type ResultRow } from "./cells";
import { QueryEditPortals, useQueryResultEditor } from "./edit";
import {
  queryExecutionSignature,
  queryExecutionStore,
  useQueryExecution,
} from "./execution";
import { columnLabel } from "./labels";
import { orderResultRows } from "./ordering";
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

export function QueryBlock({ pageId, block }: { pageId: string; block: BlockSnapshot }) {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const history = useHistoryActions();
  const { message, formatJournalDate, compare } = useI18n();
  const document = queryDocument(block.properties);
  const readonly = state.mode === "readonly";
  const owner = { kind: "block", page_id: pageId, id: block.id } as const;

  const source = document?.source ?? "";
  const storedPlan = useMemo(
    () => (document?.plan ? decodePlan(document.plan.payload, document.plan.version) : null),
    [document?.plan],
  );
  const storedPayload = storedPlan ? encodePlan(storedPlan) : null;

  const activeView = document?.views.find((view) => view.id === document.default_view_id)
    ?? document?.views[0];

  const [plan, setPlan] = useState<QueryPlan | null>(storedPlan);
  const [draft, setDraft] = useState(source);
  // The editor opens for a query that has not been written yet and stays shut for
  // one that has: a query with no conditions has nothing to say in its caption, so
  // showing it the builder is the only honest first screen. Once a reader has
  // shaped it, reopening the page shows them the answer they shaped it for. Which
  // it is, is theirs from the first press — never re-derived under their hands.
  const [editing, setEditing] = useState(() => unwritten(storedPlan, source));
  const [showSource, setShowSource] = useState(false);
  // Reading is never read-only. Without a document to write the order into, it
  // lives here for as long as the block is mounted — and it has to live *here*
  // rather than in the table, because the header's sort panel edits the same
  // list the header row does.
  const [localSorts, setLocalSorts] = useState<QueryViewSort[]>([]);
  // The authoritative document is the truth after a remote edit or a reload;
  // the local draft is the truth while the reader is typing into it.
  useEffect(() => setDraft(source), [source]);
  useEffect(() => setPlan(storedPlan), [storedPayload]); // eslint-disable-line react-hooks/exhaustive-deps

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
  const executionOwner = JSON.stringify([pageId, block.id]);
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
    executionOwner,
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
      executionStore.clear(executionOwner);
      return;
    }
    void executionStore.run(
      executionOwner,
      executionSignature,
      state.canonicalRevision,
      executionRequest,
      { force },
    );
  }, [
    executable,
    executionOwner,
    executionRequest,
    executionSignature,
    executionStore,
    state.canonicalRevision,
  ]);
  const previousExecution = useRef<{ owner: string; identity: string } | null>(null);

  useEffect(() => {
    const identity = JSON.stringify([executionSignature, state.canonicalRevision]);
    const previous = previousExecution.current;
    previousExecution.current = { owner: executionOwner, identity };
    if (!executable) {
      executionStore.clear(executionOwner);
      return;
    }
    // Activation is a demand read: a fresh cached answer renders synchronously,
    // while a missing or stale one starts immediately. Only a change observed by
    // an already-mounted query is a stream worth coalescing.
    if (!previous || previous.owner !== executionOwner) {
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
    executionOwner,
    executionSignature,
    executionStore,
    run,
    state.canonicalRevision,
  ]);

  // One command per pause in the editing, never one per keystroke.
  useEffect(() => {
    if (!plan || !compiled || readonly) return;
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
  // mounted query block, and the table rebuilds its column models whenever
  // either of these changes identity.
  const cellContext = useMemo<CellContext>(() => ({
    snapshot: state.snapshot,
    subjectVariable: compiled?.subjectVariable ?? null,
    message,
    formatDate: formatJournalDate,
    compare,
    onOpen: (entity: QueryEntityRef) => {
      if (entity.kind === "tag") return;
      history.reveal(
        entity.kind === "page"
          ? { kind: "page", id: entity.id }
          : { kind: "block", page_id: entity.page_id, id: entity.id },
      );
    },
  }), [state.snapshot, compiled?.subjectVariable, message, formatJournalDate, compare, history]);

  const resultEditor = useQueryResultEditor({
    session,
    state,
    enabled: Boolean(plan && compiled?.subjectVariable) && !readonly,
    message,
  });

  const select = result?.kind === "select" ? result : null;
  const columns = useMemo(
    () => (select && activeView
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
    if (activeView?.kind !== "list" || state.status !== "ready") return;
    const missing = resultBlockPageIds.filter(
      (pageId) => !state.hydratedPages.has(pageId)
        && state.snapshot.pages.some((page) => page.id === pageId),
    );
    if (missing.length === 0) return;
    void session.hydratePages(missing).catch((cause: unknown) => {
      notify.failure(message("failure.loadPage"), cause);
    });
  }, [
    activeView?.kind,
    message,
    notify,
    resultBlockPageIds,
    session,
    state.hydratedPages,
    state.snapshot.pages,
    state.status,
  ]);
  const sorts = useMemo(() => {
    const stored = readonly ? localSorts : (activeView?.options.sort ?? []);
    const orderableVariables = new Set(
      columns.filter((column) => column.sortable).map((column) => column.variable),
    );
    return stored.filter((sort) => orderableVariables.has(sort.variable));
  }, [activeView?.options.sort, columns, localSorts, readonly]);
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

  if (!document || !activeView) return null;

  const report = (cause: unknown) => notify.failure(message("failure.saveQuery"), cause);

  const commitSource = async () => {
    const splice = diffSplice(source, draft);
    if (!splice) return;
    await session.execute({ type: "splice_query_source", owner, ...splice }).catch(report);
  };

  const selectView = (viewId: string) => {
    if (viewId === document.default_view_id) return;
    void session
      .execute({ type: "set_query_default_view", owner, view_id: viewId })
      .catch(report);
  };

  const putView = async (next: QueryView): Promise<boolean> => {
    try {
      await session.execute({ type: "put_query_view", owner, view: next });
      return true;
    } catch (cause) {
      report(cause);
      return false;
    }
  };

  const removeQuery = () => {
    void session.execute({ type: "remove_property", owner, key: "builtin.query" }).catch(report);
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
    else putView({ ...activeView, options: { ...activeView.options, sort: next } });
  };

  const moveColumn = (variable: string, delta: -1 | 1) => {
    const order = viewColumnOrder(activeView, columns);
    const index = order.findIndex((column) => column.variable === variable);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    putView({ ...activeView, columns: next });
  };

  return (
    <section
      className="query-block"
      aria-label={message("query.section")}
      data-testid="query-block"
      // Diagnostic, not chrome. Which index revision answered is the first thing
      // to know when a result looks stale and the last thing a reader of the
      // answer cares about, so it is written where a test or a console can read
      // it and the caption stays a sentence about the query.
      data-revision={result?.revision}
    >
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
        {!error && (select || loading) && (
          <span className="query-count" data-testid="query-count">
            {select
              ? message("query.results", { count: visibleRows.length })
              : message("query.running")}
          </span>
        )}

        <div className="query-header-actions">
          {/* Order comes before layout, because it is the one a reader changes
              while reading. It is only offered once there is something to order. */}
          {columns.some((column) => column.sortable) && (
            <QuerySortControl columns={visible} sorts={sorts} onChange={setSorts} />
          )}
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
                onPointerDown={() => resultEditor.preserveDraftForViewChange()}
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
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>{message("query.view")}</DropdownMenuLabel>
              <DropdownMenuRadioGroup value={activeView.id} onValueChange={selectView}>
                {document.views.map((view) => (
                  <DropdownMenuRadioItem key={view.id} value={view.id}>
                    {viewLabel(view, message)}
                  </DropdownMenuRadioItem>
                ))}
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
                        setColumn(column.variable, { hidden: !hidden.has(column.variable) });
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
                      putView({
                        ...activeView,
                        options: { ...activeView.options, compact: !activeView.options.compact },
                      });
                    }}
                  >
                    {message("query.densityCompact")}
                  </DropdownMenuCheckboxItem>
                  {activeView.kind === "table" && (
                    <DropdownMenuCheckboxItem
                      checked={activeView.options.wrap}
                      onSelect={(event) => {
                        event.preventDefault();
                        putView({
                          ...activeView,
                          options: { ...activeView.options, wrap: !activeView.options.wrap },
                        });
                      }}
                    >
                      {message("query.wrap")}
                    </DropdownMenuCheckboxItem>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

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
            {/* Verbs only. Running is not one — the block reruns on every edit
                and every canonical revision, so a `Run` row was a button for a
                thing that already happens. Neither is the index revision: it is
                a diagnostic, and `data-revision` is where a diagnostic goes. */}
            <DropdownMenuContent align="end">
              {/* In source mode the SPARQL is already the editor, so there is
                  nothing to disclose. */}
              {plan && (
                <>
                  <DropdownMenuItem onSelect={() => setShowSource((open) => !open)}>
                    <CodeIcon aria-hidden />
                    {showSource ? message("query.hideSource") : message("query.showSource")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                </>
              )}
              <DropdownMenuItem variant="destructive" disabled={readonly} onSelect={removeQuery}>
                <Trash2Icon aria-hidden />
                {message("query.remove")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {editing && (plan ? (
        <QueryBuilder
          plan={plan}
          snapshot={state.snapshot}
          readonly={readonly}
          onChange={setPlan}
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

      <div className="query-output" aria-busy={loading}>
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
 * where the answer is not the interesting part of the block. A plan with no
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

function viewLabel(view: QueryView, message: ReturnType<typeof useI18n>["message"]): string {
  if (view.id === "table") return message("query.viewTable");
  if (view.id === "list") return message("query.viewList");
  return view.name;
}
