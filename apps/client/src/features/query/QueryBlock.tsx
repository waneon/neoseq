// A query, embedded in the outline.
//
// Two ways to say the same thing. The **builder** is the default and the only
// one `/` creates: a plan, compiled here into the SPARQL the core runs, with
// every user value travelling as a bound parameter so "due today" stays true
// tomorrow. **Source** is the escape hatch — hand-written SPARQL, which detaches
// the plan because the builder no longer describes what runs.
//
// The block owns everything stateful: the draft plan, the debounce that turns
// it into one command, the run and its generation guard, and the saved views
// that decide how the answer is laid out.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDownIcon,
  CodeIcon,
  EyeIcon,
  ListIcon,
  MoreHorizontalIcon,
  PlayIcon,
  SlidersHorizontalIcon,
  Table2Icon,
  Trash2Icon,
  WandSparklesIcon,
} from "lucide-react";
import type { QueryEntityRef, SparqlQueryResult } from "../../generated/core-port";
import type {
  BlockSnapshot,
  QueryView,
  QueryViewColumn,
  QueryViewSort,
} from "../../core-port/snapshot";
import { queryDocument } from "../../core-port/snapshot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { todayLocalDate } from "../../entities/journal";
import { compilePlan, inlinePlan, planBindings } from "../../entities/query-compile";
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
import { diffSplice } from "../outline/text-diff";
import { QueryBuilder } from "./QueryBuilder";
import { QueryListView } from "./QueryListView";
import { QueryTableView } from "./QueryTableView";
import { resultViewRows, type CellContext, type ResultColumn, type ResultRow } from "./cells";
import { QueryEditPortals, useQueryResultEditor } from "./edit";
import { columnLabel } from "./labels";

const LANGUAGE = "sparql-1.1/neoseq-v1" as const;
const RUN_DEBOUNCE_MS = 300;
const PLAN_SAVE_DEBOUNCE_MS = 600;

export function QueryBlock({ pageId, block }: { pageId: string; block: BlockSnapshot }) {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const history = useHistoryActions();
  const { message, formatJournalDate } = useI18n();
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
  const [showSource, setShowSource] = useState(false);
  const [result, setResult] = useState<SparqlQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);

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

  const run = () => {
    const current = ++generation.current;
    // A blank source is a query the user has not written yet, not a parse
    // failure — it stays quietly at "not run" instead of opening on an error.
    if (runSource.trim().length === 0) {
      setResult(null);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    void session
      .query({
        language: document?.language ?? LANGUAGE,
        source: runSource,
        bindings: runBindings,
      })
      .then((next) => {
        if (current === generation.current) setResult(next);
      })
      .catch((cause) => {
        if (current === generation.current) {
          setResult(null);
          setError(failureReason(cause, message));
        }
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
  };

  useEffect(() => {
    const timer = window.setTimeout(run, RUN_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
    // A canonical graph revision invalidates the previous derived result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runSource, runBindings, state.canonicalRevision, session]);

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
    onOpen: (entity: QueryEntityRef) => {
      if (entity.kind === "tag") return;
      history.reveal(
        entity.kind === "page"
          ? { kind: "page", id: entity.id }
          : { kind: "block", page_id: entity.page_id, id: entity.id },
      );
    },
  }), [state.snapshot, compiled?.subjectVariable, message, formatJournalDate, history]);

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
  const activeOrigin = resultEditor.active?.origin.row;
  const activeRowPresent = activeOrigin
    ? resultRows.some((row) => row.key === activeOrigin.key)
    : true;
  const pinnedRow = activeOrigin && !activeRowPresent ? activeOrigin : null;
  const visibleRows = pinnedRow ? [...resultRows, pinnedRow] : resultRows;

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

  const putView = (next: QueryView) => {
    void session.execute({ type: "put_query_view", owner, view: next }).catch(report);
  };

  /** Leaves the builder for its own output, which then stands on its own. */
  const editAsSparql = () => {
    if (!plan) return;
    void session
      .execute({ type: "set_query_source", owner, source: inlinePlan(plan, runtime) })
      .then(() => {
        setPlan(null);
        setShowSource(true);
      })
      .catch(report);
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
    putView({ ...activeView, columns: dedupe(next) });
  };

  // A header click is one command, not a debounced stream: the reader clicked
  // once and expects the order to be theirs from then on.
  const setSort = (sort: QueryViewSort | null) => {
    putView({ ...activeView, options: { ...activeView.options, sort } });
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
    >
      <div className="query-toolbar">
        <span className="query-language">
          {plan ? message("query.builderMode") : "SPARQL"}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* The toolbar controls are the bespoke 24px icon-btn, not a shadcn
                Button: its size utilities live in the `utilities` layer, which
                outranks `neoseq`, so no toolbar CSS could ever size them. */}
            <button
              type="button"
              className="icon-btn query-view-trigger"
              disabled={readonly}
              aria-label={message("query.view")}
              data-testid="query-view-trigger"
              onPointerDown={() => resultEditor.preserveDraftForViewChange()}
            >
              {activeView.kind === "table"
                ? <Table2Icon aria-hidden />
                : <ListIcon aria-hidden />}
              {viewLabel(activeView, message)}
              <ChevronDownIcon aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup value={activeView.id} onValueChange={selectView}>
              {document.views.map((view) => (
                <DropdownMenuRadioItem key={view.id} value={view.id}>
                  {view.kind === "table" ? <Table2Icon aria-hidden /> : <ListIcon aria-hidden />}
                  {viewLabel(view, message)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>

        {columns.length > 0 && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                className="icon-btn"
                disabled={readonly}
                aria-label={message("query.layout")}
                data-testid="query-layout-trigger"
              >
                <SlidersHorizontalIcon aria-hidden />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              {columns.map((column) => (
                <DropdownMenuItem
                  key={column.variable}
                  disabled={!hidden.has(column.variable) && visible.length <= 1}
                  onSelect={(event) => {
                    event.preventDefault();
                    setColumn(column.variable, { hidden: !hidden.has(column.variable) });
                  }}
                >
                  <EyeIcon aria-hidden data-checked={!hidden.has(column.variable)} />
                  {column.label}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={(event) => {
                  event.preventDefault();
                  putView({
                    ...activeView,
                    options: { ...activeView.options, compact: !activeView.options.compact },
                  });
                }}
              >
                {activeView.options.compact
                  ? message("query.densityCozy")
                  : message("query.densityCompact")}
              </DropdownMenuItem>
              {activeView.kind === "table" && (
                <DropdownMenuItem
                  onSelect={(event) => {
                    event.preventDefault();
                    putView({
                      ...activeView,
                      options: { ...activeView.options, wrap: !activeView.options.wrap },
                    });
                  }}
                >
                  {activeView.options.wrap ? message("query.noWrap") : message("query.wrap")}
                </DropdownMenuItem>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}

        <span className="query-revision">
          {result
            ? message("query.revision", { revision: result.revision })
            : loading
              ? message("query.running")
              : message("query.notRun")}
        </span>
        {/* The revision slot already says "running"; swapping or disabling the
            control on every debounced auto-run would flicker it while typing
            (§ Loading — below the flash threshold, show nothing). A stale run
            is superseded by its generation guard, so re-pressing is safe. */}
        <button
          type="button"
          className="icon-btn"
          onClick={run}
          aria-label={message("query.run")}
        >
          <PlayIcon aria-hidden />
        </button>
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
          <DropdownMenuContent align="end">
            {/* In source mode the SPARQL is already the editor, so there is
                nothing to disclose and nothing to eject from. */}
            {plan && (
              <>
                <DropdownMenuItem onSelect={() => setShowSource((open) => !open)}>
                  <CodeIcon aria-hidden />
                  {showSource ? message("query.hideSource") : message("query.showSource")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={readonly} onSelect={editAsSparql}>
                  <WandSparklesIcon aria-hidden />
                  {message("query.editAsSparql")}
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

      {plan ? (
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
          aria-label={message("query.source")}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitSource()}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              run();
            }
          }}
        />
      )}

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
        {!error && select && visibleRows.length === 0 && (
          <p className="query-empty">{message("query.noResults")}</p>
        )}
        {!error && select && visibleRows.length > 0 && activeView.kind === "table" && (
          <QueryTableView
            columns={inViewOrder(visible, activeView)}
            rows={visibleRows}
            context={cellContext}
            editor={resultEditor}
            pinnedRowKey={pinnedRow?.key}
            compact={activeView.options.compact}
            wrap={activeView.options.wrap}
            sort={activeView.options.sort}
            onSort={readonly ? undefined : setSort}
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
    const numeric = column
      ? column.aggregate !== undefined && column.aggregate !== "list"
      : select.rows.some((row) => {
          const term = row[variable];
          return term?.kind === "literal" && /#(double|decimal|integer)$/.test(term.datatype);
        });
    return {
      variable,
      label: column && plan ? columnLabel(column, plan.subject, message) : `?${variable}`,
      source: column?.source,
      aggregate: column?.aggregate,
      numeric,
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
