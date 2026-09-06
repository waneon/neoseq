import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CodeIcon,
  ListFilterIcon,
  ListIcon,
  MoreHorizontalIcon,
  SearchIcon,
  PlusIcon,
  Table2Icon,
  Trash2Icon,
} from "lucide-react";
import type {
  AuthoredQueryRequest,
  QueryEntityRef,
  SparqlQueryResult,
} from "../../generated/core-port";
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
import { todayLocalDate } from "../../entities/journal";
import { useTaskClock } from "../tasks/use-task-clock";
import { newQueryDocument } from "../../entities/query-document";
import { isSettledStatus, isTaskDateKey, TASK_STATUS_KEY } from "../../entities/tasks";
import { taskMomentDue } from "../tasks/moment-presentation";
import { canonicalEntityName, nextAvailableEntityName } from "../../entities/names";
import { QUERY_LANGUAGE } from "../../entities/query-compile";
import {
  inferOrderSemantics,
  orderSemanticsForColumn,
  orderSemanticsForField,
} from "../../entities/query-ordering";
import {
  countConditions,
  columnSourceKey,
  columnSourcesFor,
  decodePlan,
  encodePlan,
  graphPropertyKeys,
  queryFieldId,
  queryFieldsFor,
  QUERY_PLAN_VERSION,
  withColumn,
  withoutColumn,
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
import { queryResultsAreOpen, rememberQueryResultsOpen, useQueryConditions } from "./presentation";
import { planSummary, summaryLabel, type QuerySummary } from "./summary";
import { randomUUID } from "@/lib/crypto";

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

  // A presented surface does not choose the document-wide default view. Its
  // selection is local even while it may shape the selected view itself.
  const [localViewId, setLocalViewId] = useState<string | null>(null);
  const seedViews = useMemo<QueryView[]>(() => {
    return newQueryDocument(
      "",
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
  const unsupportedPlan = activeView.definition.plan != null && storedPlan === null;
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
  const plan = unsupportedPlan ? null : draft.viewId === activeView.id ? draft.plan : incomingPlan;
  const viewExecutionKey = JSON.stringify([executionKey, activeView.id]);
  const [editing, setEditing] = useQueryConditions(
    activeView,
    binding.kind === "managed" && unwritten(incomingPlan),
  );
  const [savingConditions, setSavingConditions] = useState(false);
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
    setShowSource(false);
    setLocalTableSorts([]);
    setLocalListSorts([]);
  }, [incomingPlanRef, session.graphId, viewExecutionKey]);
  const today = useMemo(() => todayLocalDate(), [state.snapshot.graph_id]);
  // A built query runs from the plan in hand, so a result follows an edit
  // without waiting for the write that persists it. Without a plan there is only
  // the stored source, which still runs.
  const outputId = useId();
  const builderId = useId();
  const focusBuilderOnOpen = useRef(false);
  useEffect(() => {
    if (!editing || !focusBuilderOnOpen.current) return;
    focusBuilderOnOpen.current = false;
    window.document
      .getElementById(builderId)
      ?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")
      ?.focus();
  }, [builderId, editing]);

  const [resultsOpen, setResultsOpen] = useState(() =>
    queryResultsAreOpen(session.graphId, viewExecutionKey),
  );
  useEffect(() => {
    setResultsOpen(queryResultsAreOpen(session.graphId, viewExecutionKey));
  }, [session.graphId, viewExecutionKey]);
  const request = useMemo<AuthoredQueryRequest | null>(
    () =>
      plan
        ? {
            kind: "built",
            plan,
            today,
          }
        : unsupportedPlan
          ? null
          : {
              kind: "raw_sparql",
              language: QUERY_LANGUAGE,
              source,
            },
    [plan, source, today, unsupportedPlan],
  );
  const {
    frame: incomingFrame,
    error: incomingError,
    loading,
    run,
  } = useQueryAnswer(
    viewExecutionKey,
    request,
    unsupportedPlan ? message("query.unsupportedPlan") : null,
  );
  const resultEditor = useQueryResultEditor({
    session,
    state,
    // Edit authority comes from the displayed row and its descriptor. A newer
    // answer must not cancel an editor that still owns an unsaved target.
    enabled: !readonly,
    message,
  });
  const displayedFrame = useRef(incomingFrame);
  const holdFrame = Boolean(
    resultEditor.active &&
    displayedFrame.current &&
    (incomingError ||
      answerDescriptor(displayedFrame.current.result) !==
        answerDescriptor(incomingFrame?.result ?? null)),
  );
  // Membership refreshes can pin a removed row. A changed descriptor instead
  // keeps the complete old frame until its editor settles, so old values never
  // acquire the field meaning or authority of a newer question.
  if (!holdFrame) displayedFrame.current = incomingFrame;
  const frame = displayedFrame.current;
  const error = holdFrame ? null : incomingError;
  const result = frame?.result ?? null;
  const canonicalBlockView =
    activeView.kind === "list" &&
    result?.kind === "built" &&
    result.grain === "entity" &&
    result.subject === "block";

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
  const saveDefinition = useLatest((payload: string) =>
    writeDefinition((target) => ({
      type: "set_query_plan",
      owner: target,
      view_id: activeView.id,
      plan: { version: QUERY_PLAN_VERSION, payload },
    })).catch((cause: unknown) => notify.failure(message("failure.saveQuery"), cause)),
  );

  // One command per pause in the editing, never one per keystroke — and never
  // one at all for a seed nobody has touched, which is what lets a tag page be
  // opened, read, and left without writing anything.
  useEffect(() => {
    if (!plan || !canEditDefinition || !shaped.current) return;
    const payload = encodePlan(plan);
    if (payload === storedPayload) return;
    const timer = window.setTimeout(() => {
      void saveDefinition.current(payload);
    }, PLAN_SAVE_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [
    canEditDefinition,
    activeView.id,
    viewExecutionKey,
    plan,
    saveDefinition,
    session,
    storedPayload,
  ]);

  const select = result && result.kind !== "ask" ? result : null;
  const columns = useMemo(
    () => (select ? resultColumns(select, activeView, message) : []),
    [select, activeView, message],
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
   * A shared clock refreshes the presentation at minute and calendar boundaries.
   */
  const taskClock = useTaskClock(
    columns.some(
      (column) => column.source?.kind === "property" && isTaskDateKey(column.source.key),
    ),
  );
  const momentDue = useCallback(
    (date: string, time: string | undefined, row: ResultRow) => {
      const status = statusVariable ? row[statusVariable]?.[0] : undefined;
      return taskMomentDue({
        date,
        time,
        settled: status?.kind === "literal" && isSettledStatus(status.value),
        ...taskClock,
        tiers: dueTiers,
      });
    },
    [statusVariable, dueTiers, taskClock],
  );

  // Both derived once, not once per render: a canonical revision re-renders every
  // mounted query, and the table rebuilds its column models whenever either of
  // these changes identity.
  const cellContext = useMemo<CellContext>(
    () => ({
      snapshot: state.snapshot,
      message,
      formatDate: formatJournalDate,
      formatTime: formatTimeOfDay,
      compare,
      momentDue,
      onOpen: (entity: QueryEntityRef) => {
        history.open(entity);
      },
    }),
    [state.snapshot, message, formatJournalDate, formatTimeOfDay, compare, momentDue, history],
  );

  const resultRows = useMemo(() => (select ? resultViewRows(select) : []), [select]);
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
    if (result?.kind !== "built" || result.grain !== "entity" || result.subject !== "block")
      return [];
    return queryFieldsFor(result.subject, graphPropertyKeys(state.snapshot)).map((field) => ({
      id: queryFieldId(field),
      field,
      ordering: orderSemanticsForField(field),
    }));
  }, [result, state.snapshot]);
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
  const visibleRows = canonicalBlockView ? listRows : tableRows;

  // The heading and disclosure describe the plan currently being authored.
  const summary = useMemo<QuerySummary>(
    () =>
      plan
        ? planSummary(plan, { snapshot: state.snapshot, message, formatDate: formatJournalDate })
        : unsupportedPlan
          ? { lead: message("query.unsupportedPlan"), detail: null }
          : { lead: "SPARQL", detail: null },
    [plan, state.snapshot, message, formatJournalDate, unsupportedPlan],
  );

  if (!document && !seedPlan) return null;

  const report = (cause: unknown) => notify.failure(message("failure.saveQuery"), cause);

  const settleResultEditor = async (): Promise<boolean> => {
    if (resultEditor.active?.phase === "markdown") return resultEditor.commit(true);
    if (resultEditor.active) resultEditor.cancel();
    return true;
  };

  const definitionInHand = plan
    ? ({
        source: "",
        language: activeView.definition.language,
        plan: { version: QUERY_PLAN_VERSION, payload: encodePlan(plan) },
      } as const)
    : activeView.definition;

  /** A view switch is a save boundary: a pending debounce must not lose a draft. */
  const flushDefinition = async () => {
    if (!canEditDefinition || !plan) return;
    const payload = encodePlan(plan);
    if (document && payload === storedPayload) return;
    shaped.current = true;
    await writeDefinition((target) => ({
      type: "set_query_plan",
      owner: target,
      view_id: activeView.id,
      plan: { version: QUERY_PLAN_VERSION, payload },
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
    void (async () => {
      if (!(await settleResultEditor())) return;
      if (!canManageViews) {
        setLocalViewId(viewId);
        return;
      }
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
      const hidesColumn = next.columns.some(
        (column) =>
          column.hidden &&
          !activeView.columns.find((current) => current.variable === column.variable)?.hidden,
      );
      if (hidesColumn && !(await settleResultEditor())) return false;
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
    const id = `v-${randomUUID()}`;
    const name = nextAvailableEntityName(
      message(kind === "table" ? "query.viewTable" : "query.viewList"),
      views.map((view) => view.name),
    );
    const position = views.reduce((highest, view) => Math.max(highest, view.position), -1) + 1;
    const definition = definitionInHand;
    void (async () => {
      if (!(await settleResultEditor())) return;
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
    const id = `v-${randomUUID()}`;
    const name = nextAvailableEntityName(
      view.name,
      views.map((item) => item.name),
    );
    const position = views.reduce((highest, item) => Math.max(highest, item.position), -1) + 1;
    const definition = view.id === activeView.id ? definitionInHand : view.definition;
    void (async () => {
      if (!(await settleResultEditor())) return;
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
      if (view.id === activeView.id && !(await settleResultEditor())) return;
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
  const choosesColumns =
    activeView.kind === "table" && canEditDefinition && plan?.grain === "entity";
  const choices =
    choosesColumns && plan
      ? columnChoices(
          columnSourcesFor(plan.subject, graphPropertyKeys(state.snapshot)),
          plan.columns,
          new Set(
            plan.columns
              .filter((column) => hidden.has(column.id))
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
  const changePlan = async (next: QueryPlan): Promise<boolean> => {
    if (!canEditDefinition) return false;
    if (
      plan &&
      JSON.stringify([plan.grain, plan.subject, plan.columns]) !==
        JSON.stringify([next.grain, next.subject, next.columns]) &&
      !(await settleResultEditor())
    )
      return false;
    shaped.current = true;
    setDraft({ viewId: activeView.id, plan: next });
    return true;
  };

  /**
   * A column switch, thrown. On is one meaning — the query selects it and this
   * table draws it. Because every view owns its own query definition, turning a
   * column off can remove it from this plan without consulting any sibling view.
   */
  const toggleColumn = async (choice: ColumnChoice, shown: boolean) => {
    if (!plan) return;
    const existing = choice.column;
    if (shown) {
      if (!existing) {
        await changePlan(withColumn(plan, choice.source));
        return;
      }
      const variable = existing.id;
      if (hidden.has(variable)) void setColumn(variable, { hidden: false });
      return;
    }
    if (!existing) return;
    const variable = existing.id;
    // The last column standing is not a switch a reader can throw, and the panel
    // says so; the plan refuses it too rather than trusting that it does.
    const next = withoutColumn(plan, existing.id);
    if (next === plan) return;
    if (!(await changePlan(next))) return;
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

  const sortOptions = canonicalBlockView
    ? listSortFields.map((descriptor) => ({
        key: descriptor.id,
        label: fieldLabel(descriptor.field, "block", message),
      }))
    : columns.flatMap((column) =>
        column.sortable ? [{ key: column.variable, label: column.label }] : [],
      );
  const sortEntries: SortControlEntry[] = canonicalBlockView
    ? listSorts.map((sort) => ({ key: sort.field, descending: sort.descending }))
    : tableSorts.map((sort) => ({ key: sort.variable, descending: sort.descending }));
  const setSortEntries = (next: SortControlEntry[]) => {
    if (canonicalBlockView) {
      setListSorts(next.map((sort) => ({ field: sort.key, descending: sort.descending })));
    } else {
      setTableSorts(next.map((sort) => ({ variable: sort.key, descending: sort.descending })));
    }
  };

  const tabbed = variant === "page" || views.length > 1;
  const conditionCount = plan ? countConditions(plan.where) : 0;

  const resultLabel = answerLabel({ frame, error, loading, run }, visibleRows.length, message);
  const resultCanCollapse = Boolean(
    error || result?.kind === "ask" || (select && visibleRows.length > 0),
  );

  const toggleEditing = async () => {
    if (savingConditions) return;
    if (readonly) {
      setEditing(!editing);
      return;
    }
    setSavingConditions(true);
    const saved = await setOption({ conditions_open: !editing });
    if (!saved) focusBuilderOnOpen.current = false;
    setSavingConditions(false);
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

  // Layout and row presentation belong to the selected saved view.
  const layoutItems = (
    <>
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
      <div className="query-header">
        <div className="query-heading">
          <SearchIcon className="query-heading-icon" aria-hidden />
          <div className="query-heading-text">
            <span className="query-title" data-testid={title ? "query-title" : undefined}>
              {title || summary.lead}
            </span>
            {!editing && summary.detail && (
              <span className="query-summary" title={summary.detail}>
                {summary.detail}
              </span>
            )}
          </div>
        </div>
        <div className="query-header-actions">
          {plan && (
            <Button
              variant="ghost"
              className="query-tool query-filter-trigger"
              aria-disabled={savingConditions || undefined}
              aria-expanded={editing}
              aria-controls={editing ? builderId : undefined}
              aria-label={message("query.conditions")}
              title={summaryLabel(summary)}
              data-testid="query-conditions-trigger"
              onClick={toggleEditing}
            >
              <ListFilterIcon aria-hidden />
              <span>{message("query.conditions")}</span>
              {conditionCount > 0 && <span className="query-tool-count">{conditionCount}</span>}
              {editing ? (
                <ChevronUpIcon className="query-tool-chevron" aria-hidden />
              ) : (
                <ChevronDownIcon className="query-tool-chevron" aria-hidden />
              )}
            </Button>
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
            <DropdownMenuContent align="end">
              {actions}
              {actions && <DropdownMenuSeparator />}
              {canManageViews && !tabbed && (
                <DropdownMenuItem onSelect={() => addView(activeView.kind)}>
                  <PlusIcon aria-hidden />
                  {message("query.newView")}
                </DropdownMenuItem>
              )}
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

      {editing && plan && (
        <QueryBuilder
          id={builderId}
          plan={plan}
          snapshot={state.snapshot}
          readonly={!canEditDefinition}
          onChange={changePlan}
        />
      )}

      {/* Rust-derived compatibility SPARQL, or the hand-written source when this
          document has no typed plan. It is never the built query's authority. */}
      {showSource && (
        <pre className="query-compiled" data-testid="query-compiled">
          <code>{source}</code>
        </pre>
      )}

      <div className="query-toolbar">
        {resultCanCollapse ? (
          <button
            type="button"
            className="query-disclosure"
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
            {resultsOpen ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
            <span
              className="query-count"
              data-state={error ? "error" : undefined}
              data-testid="query-count"
            >
              {resultLabel}
            </span>
          </button>
        ) : (
          <span className="query-disclosure" data-testid="query-disclosure">
            <span
              className="query-count"
              data-static
              data-testid="query-count"
              aria-busy={loading || undefined}
            >
              {resultLabel}
            </span>
          </span>
        )}
        <div className="query-result-tools">
          {choosesColumns && <QueryColumnsControl choices={choices} onToggle={toggleColumn} />}
          {sortOptions.length > 0 && (
            <QuerySortControl options={sortOptions} sorts={sortEntries} onChange={setSortEntries} />
          )}
          {canEditCurrentView && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  className="query-tool query-layout-trigger"
                  aria-label={message("query.displayOf", {
                    layout: message(
                      activeView.kind === "table" ? "query.viewTable" : "query.viewList",
                    ),
                  })}
                  data-testid="query-view-trigger"
                  data-view={activeView.kind}
                  onPointerDown={() => resultEditor.preserveDraftForPresentationChange()}
                >
                  {activeView.kind === "table" ? (
                    <Table2Icon aria-hidden />
                  ) : (
                    <ListIcon aria-hidden />
                  )}
                  <span>
                    {message(activeView.kind === "table" ? "query.viewTable" : "query.viewList")}
                  </span>
                  <ChevronDownIcon className="query-tool-chevron" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">{layoutItems}</DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      <div
        id={outputId}
        className="query-output"
        hidden={resultCanCollapse && !resultsOpen}
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
        {!error && !loading && select && visibleRows.length === 0 && (
          <div className="query-empty" data-testid="query-empty">
            <SearchIcon aria-hidden />
            <p>{message("query.emptyHint")}</p>
            {canEditDefinition && plan && !editing && (
              <Button
                variant="secondary"
                className="query-tool"
                aria-disabled={savingConditions || undefined}
                onClick={() => {
                  focusBuilderOnOpen.current = true;
                  toggleEditing();
                }}
              >
                <ListFilterIcon aria-hidden />
                {message("query.editConditions")}
              </Button>
            )}
          </div>
        )}
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
 * The executed descriptor owns column meaning for as long as its answer is
 * visible. A draft may already ask another question while this frame remains.
 */
function answerDescriptor(result: SparqlQueryResult | null): string {
  if (result?.kind === "built") {
    return JSON.stringify([result.kind, result.grain, result.subject, result.columns]);
  }
  return JSON.stringify(
    result?.kind === "select" ? [result.kind, result.variables] : (result?.kind ?? null),
  );
}

export function resultColumns(
  select: Exclude<SparqlQueryResult, { kind: "ask" }>,
  view: QueryView,
  message: ReturnType<typeof useI18n>["message"],
): ResultColumn[] {
  const widths = new Map(view.columns.map((column) => [column.variable, column.width]));
  if (select.kind === "built") {
    return select.columns.map((column) => {
      const ordering = orderSemanticsForColumn(column);
      return {
        variable: column.id,
        label: columnLabel(column, select.subject, message),
        source: column.source,
        aggregate: column.aggregate,
        timeColumn: column.time_column,
        ordering,
        sortable: true,
        numeric: ordering.kind === "number",
        width: widths.get(column.id) ?? null,
      };
    });
  }
  return select.variables.map((variable) => {
    const ordering = inferOrderSemantics(select.rows.map((row) => row[variable]));
    return {
      variable,
      label: `?${variable}`,
      ordering,
      sortable: true,
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
