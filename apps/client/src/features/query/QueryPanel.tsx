// A query, and the answer it stands for.
//
// One way to say it. The **builder** writes a plan, compiled here into the SPARQL
// the core runs, with every user value travelling as a bound parameter so "due
// today" stays true tomorrow. SPARQL is the executable artifact and stays
// readable — `Show SPARQL` is a disclosure on every query — but it is not an
// authoring surface: a second grammar for one document is a second product, and
// the one thing it could say that the builder cannot is not worth a reader
// meeting a text box where a question belongs. A document written by an older
// build with no plan still runs, and still reads; it simply has no editor here.
//
// **The answer is the object; the question is a disclosure.** At rest a query is
// its name, how much it found, and the result — nothing else. The name *leads*
// the line and the count ends it, and both live inside one control that spans
// the line: folding is the gesture a reader repeats, so it gets the widest
// target on the surface. Where nobody named the query there is no title and the
// count leads alone. The editor opens from an icon among the controls that act
// on the answer — beside what a table shows, how it is ordered, and how it is
// drawn, which with the question itself are the four things a reader reaches for
// while reading — so the five rows of authoring that used to sit permanently
// above every answer are there when someone is authoring and absent when nobody
// is. **The plan read back as a phrase is not printed.** A machine-written
// sentence stated over every answer forever — `Blocks · Tag is #neoseq · Status
// is any of To-do, Doing` — is chrome that repeats what the builder one hover
// away already says in rows, and it is noise beside a question the reader has
// already named. It is the name of the control that opens the question instead.
//
// **One surface, two grounds.** Embedded in the outline (`inline`) a query is a
// paragraph that answers itself, so its views live in a menu and its chrome waits
// for a pointer. Given a page of its own (`page`) the query *is* the page, so its
// views become a permanent tab strip and each one is a thing the reader names,
// arranges, and deletes. The document underneath is identical; only how much of
// it the surface is allowed to state permanently differs — and what a view *is*
// is asked in the same place on both grounds, on the answer, so a tab's own menu
// holds what is true of that view alone: its name, a copy of it, its place in the
// row, and deleting it.
//
// **A surface need not author the document it presents.** A journal's standing
// question belongs to the graph and is authored in that graph's Settings, but
// its saved view is shaped where the answer is read. The binding therefore keeps
// the document's real owner and states the surface's role separately: a managed
// surface may change the question and its collection of views; a presented one
// may change only the current view's presentation. What stays writable in either
// role is the graph — a result row is still the block it quotes.
//
// The binding owns authority; the surface owns its local disclosures. The answer
// itself has a graph-session lifetime: leaving the route or virtualizing the row
// that holds it must not turn a result back into an empty first frame when it
// returns.

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  CodeIcon,
  ListFilterIcon,
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
  QueryViewFieldSort,
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
import { Button } from "@/ui/shadcn/button";
import { nowLocalTime, todayLocalDate } from "../../entities/journal";
import { newQueryDocument } from "../../entities/query-document";
import { isSettledStatus, TASK_STATUS_KEY } from "../../entities/tasks";
import { taskMomentDue } from "../tasks/moment-presentation";
import { canonicalEntityName, nextAvailableEntityName } from "../../entities/names";
import {
  compileEntityProjection,
  compilePlan,
  isCompilerVariable,
  planBindings,
} from "../../entities/query-compile";
import {
  inferOrderSemantics,
  orderSemanticsForColumn,
  orderSemanticsForField,
} from "../../entities/query-ordering";
import {
  columnSourceKey,
  columnSourcesFor,
  columnVariable,
  decodePlan,
  encodePlan,
  graphPropertyKeys,
  queryFieldId,
  queryFieldsFor,
  QUERY_PLAN_VERSION,
  withColumn,
  withoutColumn,
  type PlanColumn,
  type QueryPlan,
} from "../../entities/query-plan";
import { useNotify } from "../notify/context";
import { useSession, useSessionSelector } from "../shell/session-context";
import { useHistoryActions } from "../history/context";
import { useI18n } from "../../i18n";
import { useDueTiers } from "../settings/preferences";
import { useLatest } from "../../lib/react";
import { QueryBuilder } from "./QueryBuilder";
import { columnChoices, QueryColumnsControl, type ColumnChoice } from "./QueryColumnsControl";
import { QueryGenericListView, QueryListView } from "./QueryListView";
import { QuerySortControl, type SortControlEntry } from "./QuerySortControl";
import { QueryTableView } from "./QueryTableView";
import { QueryViewTabs } from "./QueryViewTabs";
import { resultViewRows, type CellContext, type ResultColumn, type ResultRow } from "./cells";
import { QueryEditPortals, useQueryResultEditor } from "./edit";
import { useQueryAnswer } from "./execution";
import { answerLabel, columnLabel, fieldLabel } from "./labels";
import { orderBlockRows, orderResultRows, type ListSortField } from "./ordering";
import {
  queryEditorIsOpen,
  queryResultsAreOpen,
  rememberQueryEditorOpen,
  rememberQueryResultsOpen,
} from "./presentation";
import { planSummary, summaryLabel, type QuerySummary } from "./summary";

const PLAN_SAVE_DEBOUNCE_MS = 600;

const defaultOptions = (): QueryViewOptions => ({
  compact: false,
  wrap: false,
  sort: [],
  list_sort: [],
});

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
export type QueryBinding =
  | {
      /** This surface authors the query and manages its saved views. */
      kind: "managed";
      owner: QueryOwnerRef;
      /** Absent while a seeded query has not yet been shaped. */
      document: PropertyDocument | undefined;
      seedPlan?: QueryPlan;
    }
  | {
      /** This surface reads the query and shapes only its current saved view. */
      kind: "presented";
      owner: QueryOwnerRef;
      /** A presented query already exists; only a managed surface may create it. */
      document: PropertyDocument;
      seedPlan?: never;
    };

export interface QueryPanelProps {
  /** The document's identity and this surface's authority over it. */
  binding: QueryBinding;
  /** Stable identity for the cached answer — one per surface, not per render. */
  executionKey: string;
  variant: "inline" | "page";
  /** The section's accessible name. */
  label: string;
  /**
   * The name the reader gave this query, when they gave it one. It is the
   * panel's title — the largest thing on the surface, because a standing
   * question is known by what its owner called it and not by what it asks.
   */
  title?: string;
  /** Rows this surface's host adds to the actions menu, above its own verbs. */
  actions?: ReactNode;
  /** The block's own `Remove query`. A tag's query is part of the tag. */
  onRemove?: () => void;
}

export function QueryPanel(props: QueryPanelProps) {
  return <QueryPanelSurface key={props.executionKey} {...props} />;
}

function QueryPanelSurface({
  binding,
  executionKey,
  variant,
  label,
  title,
  actions,
  onRemove,
}: QueryPanelProps) {
  const { owner, document, seedPlan } = binding;
  const session = useSession();
  const state = useSessionSelector(
    (current) => current,
    (left, right) =>
      left.snapshot === right.snapshot &&
      left.mode === right.mode &&
      left.status === right.status &&
      left.hydratedOutlines === right.hydratedOutlines,
  );
  const notify = useNotify();
  const history = useHistoryActions();
  const { message, formatJournalDate, formatTimeOfDay, compare } = useI18n();
  const dueTiers = useDueTiers();
  const readonly = state.mode === "readonly";
  /** The question itself and the collection around its current view. */
  const canEditDefinition = binding.kind === "managed" && !readonly;
  const canManageViews = binding.kind === "managed" && !readonly;
  /** Layout belongs where the answer is read, in either surface role. */
  const canEditCurrentView = !readonly;
  const tabbed = variant === "page";

  // A presented surface does not choose the document-wide default view. Its
  // selection is local even while it may shape the selected view itself.
  const [localViewId, setLocalViewId] = useState<string | null>(null);
  const seedViews = useMemo<QueryView[]>(() => {
    const compiled = seedPlan ? compilePlan(seedPlan) : null;
    return newQueryDocument(
      compiled?.source ?? "",
      seedPlan ? { version: QUERY_PLAN_VERSION, payload: encodePlan(seedPlan) } : null,
    ).views;
  }, [seedPlan]);
  const views = document?.views ?? seedViews;
  const preferredViewId =
    (canManageViews ? null : localViewId) ?? document?.default_view_id ?? views[0].id;
  const activeView = views.find((view) => view.id === preferredViewId) ?? views[0];
  const source = activeView.definition.source;
  const storedPlan = useMemo(
    () =>
      activeView.definition.plan
        ? decodePlan(activeView.definition.plan.payload, activeView.definition.plan.version)
        : null,
    [activeView.definition.plan],
  );
  const storedPayload = storedPlan ? encodePlan(storedPlan) : null;
  const incomingPlan = storedPlan ?? (document ? null : (seedPlan ?? null));
  const incomingPlanRef = useLatest(incomingPlan);
  const [draft, setDraft] = useState<{ viewId: string; plan: QueryPlan | null }>(() => ({
    viewId: activeView.id,
    plan: incomingPlan,
  }));
  // A tab change is synchronous identity change. Until the effect adopts its
  // saved draft, render the incoming definition directly so one view can never
  // execute or save the previous view's plan for even a frame.
  const plan = draft.viewId === activeView.id ? draft.plan : incomingPlan;
  const viewExecutionKey = JSON.stringify([executionKey, activeView.id]);
  // The editor opens for a query that has not been written yet and stays shut for
  // one that has: a query with no conditions has nothing to say about itself, so
  // showing it the builder is the only honest first screen. Once a reader has
  // shaped it, reopening the page shows them the answer they shaped it for. Which
  // it is, is theirs from the first press — never re-derived under their hands,
  // and remembered in this browser past the visit that pressed it, the way the
  // fold under it is (§ presentation).
  const [editing, setEditing] = useState(
    () =>
      binding.kind === "managed" &&
      queryEditorIsOpen(
        session.graphId,
        viewExecutionKey,
        unwritten(storedPlan ?? seedPlan ?? null),
      ),
  );
  const [showSource, setShowSource] = useState(false);
  // Reading is never read-only. On a read-only graph the order lives here for as
  // long as the surface is mounted, because there is nowhere to save it.
  const [localTableSorts, setLocalTableSorts] = useState<QueryViewSort[]>([]);
  const [localListSorts, setLocalListSorts] = useState<QueryViewFieldSort[]>([]);
  // Nobody has shaped this query yet, so nothing is written for it yet. The flag
  // is what keeps merely *visiting* a seeded surface out of the graph's history.
  const shaped = useRef(document !== undefined);
  if (document !== undefined) shaped.current = true;
  // The authoritative document is the truth after a remote edit or a reload; the
  // local plan is the truth while the reader is shaping it. The encoded payload
  // is the canonical identity: a freshly allocated but equal seed is not a new
  // plan, while a stored payload change always adopts the latest decoded value.
  // A different execution key remounts this surface at the public boundary, so
  // every piece of surface-local state changes identity together.
  useEffect(
    () =>
      setDraft({
        viewId: activeView.id,
        plan: incomingPlanRef.current,
      }),
    [activeView.id, incomingPlanRef, storedPayload],
  );
  useEffect(() => {
    setEditing(
      queryEditorIsOpen(session.graphId, viewExecutionKey, unwritten(incomingPlanRef.current)),
    );
    setShowSource(false);
    setLocalTableSorts([]);
    setLocalListSorts([]);
  }, [incomingPlanRef, session.graphId, viewExecutionKey]);
  // Renderer identity decides this path, not the shape of the last response.
  // In particular, a table aggregate may omit q_subject; that must never turn a
  // block list back into a query-cell list while its own request is in flight.
  const canonicalBlockView = activeView.kind === "list" && plan?.subject === "block";

  const compiled = useMemo(() => (plan ? compilePlan(plan) : null), [plan]);
  const executionCompiled = useMemo(
    () => (canonicalBlockView && plan ? compileEntityProjection(plan) : compiled),
    [canonicalBlockView, compiled, plan],
  );
  const runtime = useMemo(
    () => ({ graphId: state.snapshot.graph_id, today: todayLocalDate() }),
    [state.snapshot.graph_id],
  );
  // A built query runs from the plan in hand, so a result follows an edit
  // without waiting for the write that persists it. Without a plan there is only
  // the stored source, which still runs.
  const runSource = executionCompiled ? executionCompiled.source : source;
  const runBindings = useMemo(
    () => (executionCompiled ? planBindings(executionCompiled.parameters, runtime) : {}),
    [executionCompiled, runtime],
  );
  const outputId = useId();
  const builderId = useId();
  const [resultsOpen, setResultsOpen] = useState(() =>
    queryResultsAreOpen(session.graphId, viewExecutionKey),
  );
  useEffect(() => {
    setResultsOpen(queryResultsAreOpen(session.graphId, viewExecutionKey));
  }, [session.graphId, viewExecutionKey]);
  const request = useMemo(
    () => ({
      language: activeView.definition.language,
      source: runSource,
      bindings: runBindings,
    }),
    [activeView.definition.language, runBindings, runSource],
  );
  const { result, error, loading, run } = useQueryAnswer(viewExecutionKey, request);

  const execute = (command: (target: QueryOwnerRef) => Command): Promise<void> =>
    session.execute(command(owner)).then(() => undefined);

  // Identity is not authority. Keeping these ports separate makes an accidental
  // definition write from a presented surface fail loudly instead of looking
  // like a successful no-op, while both roles share the saved-view command path.
  const writeDefinition = (command: (target: QueryOwnerRef) => Command): Promise<void> => {
    if (!canEditDefinition) {
      return Promise.reject(new Error("query definition is not writable"));
    }
    return execute(command);
  };
  const writeCurrentView = (command: (target: QueryOwnerRef) => Command): Promise<void> => {
    if (!canEditCurrentView) {
      return Promise.reject(new Error("query view is not writable"));
    }
    return execute(command);
  };
  const writeViewCollection = (command: (target: QueryOwnerRef) => Command): Promise<void> => {
    if (!canManageViews) {
      return Promise.reject(new Error("query views are not manageable"));
    }
    return execute(command);
  };
  const writeViewCollectionBatch = (
    commands: (target: QueryOwnerRef) => Command[],
  ): Promise<void> => {
    if (!canManageViews) {
      return Promise.reject(new Error("query views are not manageable"));
    }
    const next = commands(owner);
    if (next.length === 0) return Promise.resolve();
    return session
      .execute(next.length === 1 ? next[0] : { type: "batch", commands: next })
      .then(() => undefined);
  };
  const saveDefinition = useLatest((payload: string, compiledSource: string) =>
    writeDefinition((target) => ({
      type: "set_query_plan",
      owner: target,
      view_id: activeView.id,
      plan: { version: QUERY_PLAN_VERSION, payload },
      source: compiledSource,
    })).catch((cause: unknown) => notify.failure(message("failure.saveQuery"), cause)),
  );

  // One command per pause in the editing, never one per keystroke — and never
  // one at all for a seed nobody has touched, which is what lets a tag page be
  // opened, read, and left without writing anything.
  useEffect(() => {
    if (!plan || !compiled || !canEditDefinition || !shaped.current) return;
    const payload = encodePlan(plan);
    if (payload === storedPayload) return;
    const timer = window.setTimeout(() => {
      void saveDefinition.current(payload, compiled.source);
    }, PLAN_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    canEditDefinition,
    compiled,
    activeView.id,
    viewExecutionKey,
    plan,
    saveDefinition,
    session,
    storedPayload,
  ]);

  const select = result?.kind === "select" ? result : null;
  const columns = useMemo(
    () => (select ? resultColumns(select, plan, activeView, message) : []),
    [select, activeView, plan, message],
  );
  /** Where a row states its own task status, which is what settles a moment. */
  const statusVariable = columns.find(
    (column) => column.source?.kind === "property" && column.source.key === TASK_STATUS_KEY,
  )?.variable;

  /**
   * How far off a moment is, for every renderer that draws one. The thresholds
   * and the tones are the reader's (designs/metadata.md § Moments), and a settled row has
   * no urgency left to report — the same two rules the strip under a block
   * follows, so one task cannot be red in a table and grey in a list. The time
   * of day is the cell's to supply, and it decides only *today*: a job due at
   * nine this morning is overdue by ten.
   *
   * `today` is read at call time rather than captured: a journal left open past
   * midnight must not keep yesterday's opinion of what is overdue.
   */
  const momentDue = useCallback(
    (date: string, time: string | undefined, row: ResultRow) => {
      const status = statusVariable ? row[statusVariable] : undefined;
      return taskMomentDue({
        date,
        time,
        settled: status?.kind === "literal" && isSettledStatus(status.value),
        today: todayLocalDate(),
        now: nowLocalTime(),
        tiers: dueTiers,
      });
    },
    [statusVariable, dueTiers],
  );

  // Both derived once, not once per render: a canonical revision re-renders every
  // mounted query, and the table rebuilds its column models whenever either of
  // these changes identity.
  const cellContext = useMemo<CellContext>(
    () => ({
      snapshot: state.snapshot,
      subjectVariable: executionCompiled?.subjectVariable ?? null,
      message,
      formatDate: formatJournalDate,
      formatTime: formatTimeOfDay,
      compare,
      momentDue,
      onOpen: (entity: QueryEntityRef) => {
        history.open(entity);
      },
    }),
    [
      state.snapshot,
      executionCompiled?.subjectVariable,
      message,
      formatJournalDate,
      formatTimeOfDay,
      compare,
      momentDue,
      history,
    ],
  );

  const resultEditor = useQueryResultEditor({
    session,
    state,
    enabled: Boolean(plan && executionCompiled?.subjectVariable) && !readonly,
    message,
  });

  const resultRows = useMemo(
    () => resultViewRows((select?.rows ?? []) as ResultRow[], cellContext),
    [select, cellContext],
  );
  const resultBlockOwners = useMemo(
    () =>
      [
        ...new Map(
          resultRows.flatMap((row) => {
            if (row.subject?.kind !== "block") return [];
            const owner: OutlineOwner = row.subject.owner;
            return [[outlineOwnerKey(owner), owner] as const];
          }),
        ).values(),
      ].sort((left, right) => outlineOwnerKey(left).localeCompare(outlineOwnerKey(right))),
    [resultRows],
  );

  // A list of blocks is an entity projection, not a set of RDF cells. Resolve
  // its canonical display snapshots by page so the shared block presentation
  // sees the same markdown, task marks, tags, and property bag as the outline.
  // Table and non-block results stay query-shaped and pay no hydration cost.
  useEffect(() => {
    if (!canonicalBlockView || state.status !== "ready") return;
    const missing = resultBlockOwners.filter(
      (owner) =>
        !state.hydratedOutlines.has(outlineOwnerKey(owner)) &&
        findOutline(state.snapshot, owner) !== undefined,
    );
    if (missing.length === 0) return;
    void session.hydrateOutlines(missing).catch((cause: unknown) => {
      notify.failure(message("failure.loadPage"), cause);
    });
  }, [
    canonicalBlockView,
    message,
    notify,
    resultBlockOwners,
    session,
    state.hydratedOutlines,
    state.snapshot,
    state.status,
  ]);
  const tableSorts = useMemo(() => {
    const stored = canEditCurrentView ? (activeView.options.sort ?? []) : localTableSorts;
    const orderableVariables = new Set(
      columns.filter((column) => column.sortable).map((column) => column.variable),
    );
    return stored.filter((sort) => orderableVariables.has(sort.variable));
  }, [activeView.options.sort, columns, localTableSorts, canEditCurrentView]);
  const listSortFields = useMemo<ListSortField[]>(() => {
    if (!plan || plan.subject !== "block") return [];
    return queryFieldsFor(plan.subject, graphPropertyKeys(state.snapshot)).map((field) => ({
      id: queryFieldId(field),
      field,
      ordering: orderSemanticsForField(field),
    }));
  }, [plan, state.snapshot]);
  const listSorts = useMemo(() => {
    const stored = canEditCurrentView ? (activeView.options.list_sort ?? []) : localListSorts;
    const orderableFields = new Set(listSortFields.map((field) => field.id));
    return stored.filter((sort) => orderableFields.has(sort.field));
  }, [activeView.options.list_sort, listSortFields, localListSorts, canEditCurrentView]);
  const activeOrigin = resultEditor.active?.origin.row;
  const activeRowPresent = activeOrigin
    ? resultRows.some((row) => row.key === activeOrigin.key)
    : true;
  const pinnedRow = activeOrigin && !activeRowPresent ? activeOrigin : null;
  const resultAndPinnedRows = useMemo(
    () => (pinnedRow ? [...resultRows, pinnedRow] : resultRows),
    [pinnedRow, resultRows],
  );
  const tableRows = useMemo(
    () => orderResultRows(resultAndPinnedRows, tableSorts, columns, cellContext),
    [cellContext, columns, resultAndPinnedRows, tableSorts],
  );
  const listRows = useMemo(
    () => orderBlockRows(resultAndPinnedRows, listSorts, listSortFields, cellContext),
    [cellContext, listSortFields, listSorts, resultAndPinnedRows],
  );
  const visibleRows = activeView.kind === "list" ? listRows : tableRows;

  // The plan read back as a phrase, following the plan in hand rather than the
  // saved one so it tracks the builder keystroke for keystroke. It is no longer
  // printed in the header: a machine-written sentence stated permanently over
  // every answer is chrome, and the question already has a name where anybody
  // gave it one. It stays the name of the control that *opens* the question, so
  // reading what a query asks costs one hover rather than a line of the surface.
  const summary = useMemo<QuerySummary>(
    () =>
      plan
        ? planSummary(plan, { snapshot: state.snapshot, message, formatDate: formatJournalDate })
        : { lead: "SPARQL", detail: null },
    [plan, state.snapshot, message, formatJournalDate],
  );

  if (!document && !seedPlan) return null;

  const report = (cause: unknown) => notify.failure(message("failure.saveQuery"), cause);

  const definitionInHand =
    plan && compiled
      ? ({
          source: compiled.source,
          language: activeView.definition.language,
          plan: { version: QUERY_PLAN_VERSION, payload: encodePlan(plan) },
        } as const)
      : activeView.definition;

  /** A view switch is a save boundary: a pending debounce must not lose a draft. */
  const flushDefinition = async () => {
    if (!canEditDefinition || !plan || !compiled) return;
    const payload = encodePlan(plan);
    if (document && payload === storedPayload) return;
    shaped.current = true;
    await writeDefinition((target) => ({
      type: "set_query_plan",
      owner: target,
      view_id: activeView.id,
      plan: { version: QUERY_PLAN_VERSION, payload },
      source: compiled.source,
    }));
  };

  /**
   * A managed seed becomes a written query the moment somebody shapes it. Its
   * view commands go through here first so they always find a document; a
   * presented binding is already stored by construction.
   */
  const materialize = async () => {
    if (document) return;
    await flushDefinition();
  };

  const selectView = (viewId: string) => {
    if (viewId === activeView.id) return;
    if (!canManageViews) {
      setLocalViewId(viewId);
      return;
    }
    void (async () => {
      await flushDefinition();
      await writeViewCollection((target) => ({
        type: "set_query_default_view",
        owner: target,
        view_id: viewId,
      }));
    })().catch(report);
  };

  const putCurrentView = async (next: QueryView): Promise<boolean> => {
    try {
      if (binding.kind === "managed") await materialize();
      await writeCurrentView((target) => ({
        type: "put_query_view",
        owner: target,
        view: next,
      }));
      return true;
    } catch (cause) {
      report(cause);
      return false;
    }
  };

  const putManagedView = async (next: QueryView): Promise<boolean> => {
    try {
      await materialize();
      await writeViewCollection((target) => ({
        type: "put_query_view",
        owner: target,
        view: next,
      }));
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
    const definition = definitionInHand;
    void (async () => {
      await flushDefinition();
      await writeViewCollectionBatch((target) => [
        {
          type: "put_query_view",
          owner: target,
          view: {
            id,
            name,
            definition: {
              ...definition,
              plan: definition.plan ? { ...definition.plan } : null,
            },
            kind,
            position,
            columns: [],
            options: defaultOptions(),
          },
        },
        { type: "set_query_default_view", owner: target, view_id: id },
      ]);
    })().catch(report);
  };

  const duplicateView = (view: QueryView) => {
    const id = `v-${crypto.randomUUID()}`;
    const name = nextAvailableEntityName(
      view.name,
      views.map((item) => item.name),
    );
    const position = views.reduce((highest, item) => Math.max(highest, item.position), -1) + 1;
    const definition = view.id === activeView.id ? definitionInHand : view.definition;
    void (async () => {
      if (view.id === activeView.id) await flushDefinition();
      else await materialize();
      await writeViewCollectionBatch((target) => [
        {
          type: "put_query_view",
          owner: target,
          view: {
            ...view,
            id,
            name,
            position,
            definition: {
              ...definition,
              plan: definition.plan ? { ...definition.plan } : null,
            },
          },
        },
        { type: "set_query_default_view", owner: target, view_id: id },
      ]);
    })().catch(report);
  };

  const renameView = (view: QueryView, name: string) => {
    const next = name.trim();
    if (!next || next === view.name) return;
    const taken = views.some(
      (item) => item.id !== view.id && canonicalEntityName(item.name) === canonicalEntityName(next),
    );
    const unique = taken
      ? nextAvailableEntityName(
          next,
          views.map((item) => item.name),
        )
      : next;
    void putManagedView({ ...view, name: unique });
  };

  const removeView = (view: QueryView) => {
    if (views.length <= 1) return;
    void (async () => {
      await materialize();
      await writeViewCollection((target) => ({
        type: "remove_query_view",
        owner: target,
        view_id: view.id,
      }));
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
      await writeViewCollectionBatch((target) =>
        next.flatMap((view, position) =>
          view.position === position
            ? []
            : [{ type: "put_query_view", owner: target, view: { ...view, position } }],
        ),
      );
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
  /** What this table draws. A canonical block list has no column projection. */
  const shownColumns = columns.filter((column) => !hidden.has(column.variable));

  /**
   * Every column this table could draw, and which of them it does. The plan's
   * columns are what the query *returns* and the view's are what this table
   * *shows*; one switch answers for both, because a reader asking for a column
   * means both at once. The graph's vocabulary is read through a snapshot cache,
   * so the builder beside this pays for the walk once.
   *
   * A list has nothing to choose between — it draws canonical entities, not a
   * grid — so it has no panel and does not participate in this projection.
   */
  const choosesColumns = activeView.kind === "table" && canEditDefinition && plan !== null;
  const choices =
    choosesColumns && plan
      ? columnChoices(
          columnSourcesFor(plan.subject, graphPropertyKeys(state.snapshot)),
          plan.columns,
          new Set(
            plan.columns
              .filter((column) => hidden.has(columnVariable(column)))
              .map((column) => columnSourceKey(column.source)),
          ),
          plan.subject,
          message,
        )
      : [];

  // The first layout change writes the whole running order, so later ones have
  // a list to patch rather than a partial one to merge into.
  const setColumn = (variable: string, patch: Partial<QueryViewColumn>) => {
    const base = viewColumnOrder(activeView, columns);
    const next = base.some((column) => column.variable === variable)
      ? base.map((column) => (column.variable === variable ? { ...column, ...patch } : column))
      : [...base, { variable, hidden: false, width: null, ...patch }];
    return putCurrentView({ ...activeView, columns: dedupe(next) });
  };

  /**
   * The widths the reader now owns, in one command. A table hands back every
   * column's width rather than only the one that moved: a column that has never
   * been given a width is drawn at the table's own fallback, so writing one
   * column alone left every other one to jump to a shape nobody asked for
   * (§ QueryTableView — a drag starts from the width on screen).
   */
  const setColumnWidths = (widths: Record<string, number | null>) => {
    const base = viewColumnOrder(activeView, columns);
    const known = new Set(base.map((column) => column.variable));
    return putCurrentView({
      ...activeView,
      columns: dedupe([
        ...base.map((column) =>
          column.variable in widths ? { ...column, width: widths[column.variable] } : column,
        ),
        ...Object.entries(widths)
          .filter(([variable]) => !known.has(variable))
          .map(([variable, width]) => ({ variable, hidden: false, width })),
      ]),
    });
  };

  /**
   * Every plan edit, from the builder and from the column switches alike. The
   * flag is what turns a seed nobody has touched into a document; the write
   * itself is the debounced one above.
   */
  const changePlan = (next: QueryPlan) => {
    shaped.current = true;
    setDraft({ viewId: activeView.id, plan: next });
  };

  /**
   * A column switch, thrown. On is one meaning — the query selects it and this
   * table draws it. Because every view owns its own query definition, turning a
   * column off can remove it from this plan without consulting any sibling view.
   */
  const toggleColumn = (choice: ColumnChoice, shown: boolean) => {
    if (!plan) return;
    const existing = choice.column;
    if (shown) {
      if (!existing) {
        changePlan(withColumn(plan, choice.source));
        return;
      }
      const variable = columnVariable(existing);
      if (hidden.has(variable)) void setColumn(variable, { hidden: false });
      return;
    }
    if (!existing) return;
    const variable = columnVariable(existing);
    // The last column standing is not a switch a reader can throw, and the panel
    // says so; the plan refuses it too rather than trusting that it does.
    const next = withoutColumn(plan, existing.id);
    if (next === plan) return;
    changePlan(next);
    // The view's record of a column the query no longer has is not a memory of
    // anything, so it goes with it.
    if (activeView.columns.some((column) => column.variable === variable)) {
      void putCurrentView({
        ...activeView,
        columns: activeView.columns.filter((column) => column.variable !== variable),
      });
    }
  };

  // A header click is one command, not a debounced stream: the reader clicked
  // once and expects the order to be theirs from then on.
  const setTableSorts = (next: QueryViewSort[]) => {
    if (canEditCurrentView) {
      void putCurrentView({ ...activeView, options: { ...activeView.options, sort: next } });
    } else {
      setLocalTableSorts(next);
    }
  };

  const setListSorts = (next: QueryViewFieldSort[]) => {
    if (canEditCurrentView) {
      void putCurrentView({ ...activeView, options: { ...activeView.options, list_sort: next } });
    } else {
      setLocalListSorts(next);
    }
  };

  const moveColumn = (variable: string, delta: -1 | 1) => {
    const order = viewColumnOrder(activeView, columns);
    const index = order.findIndex((column) => column.variable === variable);
    const target = index + delta;
    if (index < 0 || target < 0 || target >= order.length) return;
    const next = [...order];
    [next[index], next[target]] = [next[target], next[index]];
    void putCurrentView({ ...activeView, columns: next });
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
    void putCurrentView({ ...activeView, columns: [...next, ...rest] });
  };

  const setOption = (patch: Partial<QueryView["options"]>) =>
    putCurrentView({ ...activeView, options: { ...activeView.options, ...patch } });

  const sortOptions =
    activeView.kind === "list"
      ? (canonicalBlockView ? listSortFields : []).map((descriptor) => ({
          key: descriptor.id,
          label: fieldLabel(descriptor.field, "block", message),
        }))
      : columns.flatMap((column) =>
          column.sortable ? [{ key: column.variable, label: column.label }] : [],
        );
  const sortEntries: SortControlEntry[] =
    activeView.kind === "list"
      ? listSorts.map((sort) => ({ key: sort.field, descending: sort.descending }))
      : tableSorts.map((sort) => ({ key: sort.variable, descending: sort.descending }));
  const setSortEntries = (next: SortControlEntry[]) => {
    if (activeView.kind === "list") {
      setListSorts(next.map((sort) => ({ field: sort.key, descending: sort.descending })));
    } else {
      setTableSorts(next.map((sort) => ({ variable: sort.key, descending: sort.descending })));
    }
  };

  const resultLabel = answerLabel({ result, error, loading, run }, visibleRows.length, message);
  const resultCanCollapse = Boolean(
    error || result?.kind === "ask" || (select && visibleRows.length > 0),
  );

  /* The two disclosures of one surface, and each remembers its own answer. The
     question is the reader's working state, not the query's, so it is written
     where the fold is: in this browser, against this graph and this key. */
  const toggleEditing = () => {
    const nextOpen = !editing;
    rememberQueryEditorOpen(session.graphId, viewExecutionKey, nextOpen);
    setEditing(nextOpen);
  };

  const toggleResults = async () => {
    const nextOpen = !resultsOpen;
    if (!nextOpen && resultEditor.active) {
      if (resultEditor.active.phase === "markdown") {
        if (!(await resultEditor.commit(true))) return;
      } else {
        resultEditor.cancel();
      }
    }
    rememberQueryResultsOpen(session.graphId, viewExecutionKey, nextOpen);
    setResultsOpen(nextOpen);
  };

  /* The switches that shape one view: which renderer, and how tall its rows are.
     They hang under the layout icon on both grounds, beside the columns panel and
     the sort panel, because they are the same kind of fact as those two — how
     this answer is laid out, changed while reading it. A page's tab strip used to
     hold them in the tab's own menu, which put the same choice in two places
     depending on where the query was read and left a tab's menu answering for
     two things at once: what this view *is*, and what this view is *called*.
     Which columns a table draws is not among them either — it is a table's own
     question, asked on the table (§ QueryColumnsControl). */
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
        onValueChange={(kind) =>
          void putCurrentView({ ...activeView, kind: kind as QueryViewKind })
        }
      >
        <DropdownMenuRadioItem value="table">{message("query.viewTable")}</DropdownMenuRadioItem>
        <DropdownMenuRadioItem value="list">{message("query.viewList")}</DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuLabel>{message("query.rows")}</DropdownMenuLabel>
      {/* A checked switch says what is on. The label used to flip between
          `Compact rows` and `Roomy rows`, which left the reader guessing whether
          it named the state or the verb. */}
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
      // it and the header stays the query's name and how much it found.
      data-revision={result?.revision}
    >
      {tabbed && (
        <QueryViewTabs
          views={views}
          activeView={activeView}
          readonly={!canManageViews}
          panelId={outputId}
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
        {/* The name of the question, and how much it found — the two facts a
            folded query still has to state, in the one control that folds it.
            The disclosure spans the line rather than hugging its own words: the
            gesture a reader repeats deserves the widest target on the surface,
            and the name and the count then land where a reader looks for them —
            the title at the left edge, the count at the far end.

            **The name leads and the count follows it.** A named question is
            known by its name; the count is a fact *about* its answer, so it is
            stated at the end of the line in the metadata voice. Where nobody
            named the query there is no title, and the count takes the lead as
            the only thing there is to name the answer by.

            On the first run there is nothing to count yet and it says so;
            afterwards a rerun updates the number in place rather than flickering
            `running` over it on every debounced keystroke. */}
        {(title || resultLabel) &&
          (resultCanCollapse ? (
            <button
              type="button"
              className="query-disclosure"
              data-titled={title ? true : undefined}
              aria-expanded={resultsOpen}
              aria-controls={outputId}
              aria-label={message(resultsOpen ? "query.collapseResults" : "query.expandResults", {
                result: [title, resultLabel].filter(Boolean).join(" · "),
              })}
              aria-busy={loading || undefined}
              data-testid="query-disclosure"
              onPointerDown={() => resultEditor.preserveDraftForPresentationChange()}
              onClick={() => void toggleResults()}
            >
              {/* A swap, not a rotation: designs/foundations.md § Motion allows no transform animation on
                anything a pointer must hit or an audit must read. */}
              {resultsOpen ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
              {title && (
                <span className="query-title" data-testid="query-title">
                  {title}
                </span>
              )}
              {resultLabel && (
                <span
                  className="query-count"
                  data-state={error ? "error" : undefined}
                  data-testid="query-count"
                >
                  {resultLabel}
                </span>
              )}
            </button>
          ) : (
            <span
              className="query-disclosure"
              data-titled={title ? true : undefined}
              data-testid="query-disclosure"
            >
              {title && (
                <span className="query-title" data-testid="query-title">
                  {title}
                </span>
              )}
              {resultLabel && (
                <span
                  className="query-count"
                  data-static
                  data-state={error ? "error" : undefined}
                  data-testid="query-count"
                  aria-busy={loading || undefined}
                >
                  {resultLabel}
                </span>
              )}
            </span>
          ))}

        <div className="query-header-actions">
          {/* What it asks, then what the table shows, then how it is ordered,
              then what it is: the question first, because it is the one control
              here that changes the answer rather than the reading of it, and the
              switches a reader throws while reading before the one they set once.

              A presented document has no editor here: a control that opened one
              for a question authored somewhere else would be a promise the
              surface cannot keep, and the route to its author is a row in the
              `⋯` menu, named after that place. */}
          {binding.kind === "managed" && plan && (
            <Button
              size="icon"
              aria-expanded={editing}
              aria-controls={editing ? builderId : undefined}
              aria-label={message("query.conditions")}
              // The plan read back as a phrase, on the control that opens it:
              // what a query asks is written in the words the builder said it
              // in, one hover from the answer, rather than printed permanently
              // over every result whether anybody is reading it or not.
              title={summaryLabel(summary)}
              // No lit state here, unlike the sort control's: a query with no
              // conditions is one nobody has written yet, so a mark for "this
              // answer is narrowed" would be on for every query in the graph.
              data-testid="query-conditions-trigger"
              onClick={toggleEditing}
            >
              <ListFilterIcon aria-hidden />
            </Button>
          )}
          {choosesColumns && <QueryColumnsControl choices={choices} onToggle={toggleColumn} />}
          {sortOptions.length > 0 && (
            <QuerySortControl options={sortOptions} sorts={sortEntries} onChange={setSortEntries} />
          )}
          {/* These are facts about the current saved view, so they remain where
              the answer is read even when its question is authored elsewhere. */}
          {canEditCurrentView && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon"
                  // The menu is wider than the view it opens on, so the name is the
                  // whole question it answers, not just its first group.
                  aria-label={message("query.display")}
                  data-testid="query-view-trigger"
                  data-view={activeView.kind}
                  onPointerDown={() => resultEditor.preserveDraftForPresentationChange()}
                >
                  {activeView.kind === "table" ? (
                    <Table2Icon aria-hidden />
                  ) : (
                    <ListIcon aria-hidden />
                  )}
                </Button>
              </DropdownMenuTrigger>
              {/* One menu, because table-or-list and how tall the rows are answer
                  one question: how this answer is laid out. Table columns remain
                  on the table itself.

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
              <Button
                size="icon"
                aria-label={message("query.actions")}
                data-testid="query-actions-trigger"
              >
                <MoreHorizontalIcon aria-hidden />
              </Button>
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
              {/* Every query has a source that runs, and no query has an editor
                  for it: reading what the graph was actually asked is a
                  disclosure here, on the surface that asked it. */}
              {actions && <DropdownMenuSeparator />}
              <DropdownMenuItem onSelect={() => setShowSource((open) => !open)}>
                <CodeIcon aria-hidden />
                {showSource ? message("query.hideSource") : message("query.showSource")}
              </DropdownMenuItem>
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

      {editing && plan && (
        <QueryBuilder
          id={builderId}
          plan={plan}
          snapshot={state.snapshot}
          readonly={readonly}
          onChange={changePlan}
        />
      )}

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
            columns={inViewOrder(shownColumns, activeView)}
            rows={visibleRows}
            context={cellContext}
            editor={resultEditor}
            pinnedRowKey={pinnedRow?.key}
            compact={activeView.options.compact}
            wrap={activeView.options.wrap}
            sorts={tableSorts}
            onSort={setTableSorts}
            onResize={canEditCurrentView ? setColumnWidths : undefined}
            onHide={
              canEditCurrentView ? (variable) => setColumn(variable, { hidden: true }) : undefined
            }
            onMove={canEditCurrentView ? moveColumn : undefined}
            onReorder={canEditCurrentView ? reorderColumns : undefined}
          />
        )}
        {!error && select && visibleRows.length > 0 && canonicalBlockView && (
          <QueryListView
            rows={visibleRows}
            context={cellContext}
            editor={resultEditor}
            pinnedRowKey={pinnedRow?.key}
            compact={activeView.options.compact}
          />
        )}
        {!error &&
          select &&
          visibleRows.length > 0 &&
          activeView.kind === "list" &&
          !canonicalBlockView && (
            <QueryGenericListView
              columns={columns}
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
 * conditions matches everything, so the editor is what the reader came for. A
 * document with no plan has no editor to open at all.
 */
function unwritten(plan: QueryPlan | null): boolean {
  return plan !== null && plan.where.children.length === 0;
}

/**
 * The result's columns, told apart by the plan that asked for them. A variable
 * the plan does not know — a plan-less document, or one the builder has since
 * changed — still gets a column, named after itself.
 */
function resultColumns(
  select: { variables: string[]; rows: ResultRow[] },
  plan: QueryPlan | null,
  view: QueryView,
  message: ReturnType<typeof useI18n>["message"],
): ResultColumn[] {
  const planned = new Map<string, PlanColumn>();
  if (plan) for (const column of plan.columns) planned.set(columnVariable(column), column);
  const widths = new Map(view.columns.map((column) => [column.variable, column.width]));
  // What the compiler selected for itself is carried, not shown: row identity,
  // which is what a text cell links to, and the time of day that refines a
  // moment's column. Neither is ever a column, whether or not *this* plan still
  // carries one — a plan that has just gained a summary drops the subject, and
  // the answer it drops it from is on screen until the next one lands. A
  // hand-written query keeps every variable it selected: they are its own.
  return select.variables
    .filter((variable) => !(plan && isCompilerVariable(variable)))
    .map((variable) => {
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
  return [...columns].sort(
    (left, right) =>
      (position.get(left.variable) ?? Number.MAX_SAFE_INTEGER) -
      (position.get(right.variable) ?? Number.MAX_SAFE_INTEGER),
  );
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
