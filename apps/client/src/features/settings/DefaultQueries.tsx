// Where a journal's standing questions are written.
//
// The journal reads them and this writes them, which is the whole shape of the
// feature: a standing question is set up once and then read every day, so its
// editor belongs with this graph's other settings and not parked under
// the writing it sits below (§ Do / Don't — nothing below the outline is chrome).
//
// **A row states the question, not the machinery.** Its caption is the same
// phrase the journal will print above the answer, and beside it the same count
// the journal will print beside it — so the row is a preview at the size it will
// render, which is what every other choice in this dialog owes the reader. A
// broken query says so here, where it can be fixed, and not only there.
//
// **One entrance, the same one the outline has.** `/` builds a query; so does
// this. Nothing here is a second authoring grammar: the builder is the product's
// own, and what it compiles is stored beside the plan exactly as the graph stores
// its own queries. A standing question read as a table says which columns it
// shows here too, because Settings is the only surface that owns it.

import { useEffect, useId, useMemo, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  MoreHorizontalIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react";
import { Input } from "@/ui/shadcn/input";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import type { QueryViewKind } from "../../core-port/snapshot";
import {
  clearLegacyDefaultQueries,
  defaultQueryKey,
  legacyDefaultQueryId,
  legacyDefaultQueries,
  MAX_DEFAULT_QUERIES,
  MAX_DEFAULT_QUERY_TITLE,
  newDefaultQueryDocument,
  type DefaultQuery,
} from "../../entities/default-queries";
import { todayLocalDate } from "../../entities/journal";
import { compilePlan, planBindings, QUERY_LANGUAGE } from "../../entities/query-compile";
import {
  columnSourcesFor,
  decodePlan,
  defaultPlan,
  encodePlan,
  graphPropertyKeys,
  QUERY_PLAN_VERSION,
  withColumn,
  withColumnAggregate,
  withoutColumn,
  type PlanAggregate,
  type QueryPlan,
} from "../../entities/query-plan";
import { useQueryAnswer } from "../query/execution";
import { answerLabel } from "../query/labels";
import { QueryBuilder } from "../query/QueryBuilder";
import {
  columnChoices,
  QueryColumnsControl,
  type ColumnChoice,
} from "../query/QueryColumnsControl";
import { planSummary, summaryLabel } from "../query/summary";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { useI18n } from "../../i18n";

/** The two layouts a journal may read an answer through. */
const LAYOUTS: QueryViewKind[] = ["list", "table"];

export function DefaultQueriesSection() {
  const { message } = useI18n();
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const queries = state.snapshot.settings.default_queries;
  const [legacy, setLegacy] = useState(legacyDefaultQueries);
  const legacyImports = useMemo(
    () => legacy.map((query, index) => ({
      id: legacyDefaultQueryId(query, index),
      title: query.title,
      document: newDefaultQueryDocument(query.source, query.plan, query.layout),
    })),
    [legacy],
  );
  const importedIds = new Set(queries.map((query) => query.id));
  const pendingLegacyImports = legacyImports.filter((query) => !importedIds.has(query.id));
  // One editor at a time. A builder is five rows tall, and eight of them open at
  // once turns a pane that scrolls into a pane that only scrolls.
  const [openId, setOpenId] = useState<string | null>(null);
  const full = queries.length >= MAX_DEFAULT_QUERIES;

  useEffect(() => {
    if (
      legacy.length > 0
      && pendingLegacyImports.length === 0
      && state.save.kind === "saved"
    ) {
      clearLegacyDefaultQueries();
      setLegacy([]);
    }
  }, [legacy.length, pendingLegacyImports.length, state.save.kind]);

  /** A new query opens on itself: adding one and not landing on it says nothing. */
  const create = (plan: QueryPlan) => {
    const id = `dq-${crypto.randomUUID()}`;
    void session.execute({
      type: "create_default_query",
      default_query_id: id,
      title: "",
      document: newDefaultQueryDocument(
        compilePlan(plan).source,
        { version: QUERY_PLAN_VERSION, payload: encodePlan(plan) },
        "list",
      ),
    }).then(() => setOpenId(id)).catch((cause: unknown) => {
      notify.failure(message("failure.saveQuery"), cause);
    });
  };

  const importLegacy = () => {
    if (pendingLegacyImports.length === 0) return;
    void session.execute({ type: "import_default_queries", queries: pendingLegacyImports })
      .then(() => {
        if (session.getState().save.kind === "saved") {
          clearLegacyDefaultQueries();
          setLegacy([]);
        }
      })
      .catch((cause: unknown) => notify.failure(message("failure.saveQuery"), cause));
  };

  return (
    <section className="settings-section">
      <h2>{message("settings.defaultQueries")}</h2>
      <p>{message("settings.defaultQueriesDescription")}</p>
      {legacy.length > 0 && (
        <div className="field">
          <p>{message("settings.legacyDefaultQueriesDescription", { count: legacy.length })}</p>
          <button
            type="button"
            className="btn"
            disabled={
              state.mode === "readonly"
              || state.save.kind === "unsaved"
              || pendingLegacyImports.length === 0
              || queries.length + pendingLegacyImports.length > MAX_DEFAULT_QUERIES
            }
            data-testid="import-legacy-default-queries"
            onClick={importLegacy}
          >
            {message("settings.importLegacyDefaultQueries")}
          </button>
        </div>
      )}
      {queries.length > 0 && (
        <ul className="default-queries" data-testid="settings-default-queries">
          {queries.map((query, index) => (
            <DefaultQueryRow
              key={query.id}
              query={query}
              open={openId === query.id}
              first={index === 0}
              last={index === queries.length - 1}
              index={index}
              onOpen={(open) => setOpenId(open ? query.id : null)}
            />
          ))}
        </ul>
      )}
      {/* The empty state *is* the action, so this is the section's own floor
          rather than a row that appears once something else exists. */}
      <div className="default-query-add">
        <button
          type="button"
          className="btn"
          disabled={full || state.mode === "readonly"}
          data-testid="add-default-query"
          onClick={() => create(defaultPlan("block"))}
        >
          <PlusIcon aria-hidden />
          {message("settings.addDefaultQuery")}
        </button>
      </div>
      {/* A disabled button has to say what would re-enable it. */}
      {full && (
        <p className="field-error" role="status">
          {message("settings.defaultQueryLimit", { count: MAX_DEFAULT_QUERIES })}
        </p>
      )}
    </section>
  );
}

function DefaultQueryRow({
  query,
  open,
  first,
  last,
  index,
  onOpen,
}: {
  query: DefaultQuery;
  open: boolean;
  first: boolean;
  last: boolean;
  index: number;
  onOpen: (open: boolean) => void;
}) {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const { message, formatJournalDate } = useI18n();
  const bodyId = useId();
  // The payload, not the record: every write rebuilds the stored object, so a
  // memo keyed on its identity would recompile the plan on each keystroke of the
  // name beside it.
  const payload = query.document.plan?.payload;
  const plan = useMemo(
    () => (payload ? decodePlan(payload, QUERY_PLAN_VERSION) : null),
    [payload],
  );
  const compiled = useMemo(() => (plan ? compilePlan(plan) : null), [plan]);
  const runtime = useMemo(
    () => ({ graphId: state.snapshot.graph_id, today: todayLocalDate() }),
    [state.snapshot.graph_id],
  );
  // The same request the journal will make, so the two share one execution: the
  // count here is the count there rather than a second opinion about it.
  const request = useMemo(() => ({
    language: QUERY_LANGUAGE,
    source: compiled ? compiled.source : query.document.source,
    bindings: compiled ? planBindings(compiled.parameters, runtime) : {},
  }), [compiled, query.document.source, runtime]);
  const answer = useQueryAnswer(defaultQueryKey(query), request);
  const count = answerLabel(answer, null, message);

  const summary = plan
    ? planSummary(plan, {
        snapshot: state.snapshot,
        message,
        formatDate: formatJournalDate,
      })
    : { lead: "SPARQL", detail: null };
  const name = query.title || summaryLabel(summary);

  const owner = { kind: "graph_default", default_query_id: query.id } as const;
  const activeView = query.document.views.find(
    (view) => view.id === query.document.default_view_id,
  ) ?? query.document.views[0]!;
  const save = (command: Parameters<typeof session.execute>[0]) => {
    void session.execute(command).catch((cause: unknown) => {
      notify.failure(message("failure.saveQuery"), cause);
    });
  };
  /** A plan and the SPARQL it compiles to are written together, never apart. */
  const commitPlan = (next: QueryPlan) => {
    save({
      type: "set_query_plan",
      owner,
      plan: { version: QUERY_PLAN_VERSION, payload: encodePlan(next) },
      source: compilePlan(next).source,
    });
  };

  // A standing question is read through exactly one view, so there is nothing to
  // hide a column *in*: the switch and the query's own columns are the same list,
  // and turning one off takes it out of the question.
  const choices = plan
    ? columnChoices(
      columnSourcesFor(plan.subject, graphPropertyKeys(state.snapshot)),
      plan.columns,
      new Set<string>(),
      plan.subject,
      message,
    )
    : [];

  const toggleColumn = (choice: ColumnChoice, shown: boolean) => {
    if (!plan) return;
    if (shown) commitPlan(withColumn(plan, choice.source));
    else if (choice.column) commitPlan(withoutColumn(plan, choice.column.id));
  };

  const summarizeColumn = (choice: ColumnChoice, aggregate: PlanAggregate | undefined) => {
    if (plan && choice.column) commitPlan(withColumnAggregate(plan, choice.column.id, aggregate));
  };

  return (
    <li className="default-query" data-open={open || undefined}>
      <div className="default-query-head">
        <button
          type="button"
          className="icon-btn"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          aria-label={message("settings.editDefaultQuery", { name })}
          data-testid="default-query-disclose"
          onClick={() => onOpen(!open)}
        >
          {open ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
        </button>
        {/* The name is a field, because it is the one thing here the reader
            writes in their own words. Empty, it shows the question itself — which
            is also what the journal captions the answer with, so leaving it blank
            is a choice rather than an omission. */}
        <Input
          aria-label={message("settings.defaultQueryName")}
          value={query.title}
          placeholder={summaryLabel(summary)}
          maxLength={MAX_DEFAULT_QUERY_TITLE}
          data-testid="default-query-title"
          disabled={state.mode === "readonly"}
          onChange={(event) => save({
            type: "rename_default_query",
            default_query_id: query.id,
            title: event.target.value,
          })}
        />
        {count && (
          <span
            className="query-count"
            data-state={answer.error ? "error" : undefined}
            aria-busy={answer.loading || undefined}
            data-testid="default-query-count"
          >
            {count}
          </span>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className="icon-btn"
              aria-label={message("settings.defaultQueryActions", { name })}
              disabled={state.mode === "readonly"}
              data-testid="default-query-actions"
            >
              <MoreHorizontalIcon aria-hidden />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* Order is the order they are read in, and a list this short is
                ordered by saying so — the drag a longer list would earn buys
                nothing a phone or a keyboard can use. */}
            <DropdownMenuItem
              disabled={first || state.mode === "readonly"}
              data-testid="default-query-up"
              onSelect={() => save({
                type: "move_default_query",
                default_query_id: query.id,
                index: index - 1,
              })}
            >
              <ChevronUpIcon aria-hidden />
              {message("common.moveUp")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={last || state.mode === "readonly"}
              data-testid="default-query-down"
              onSelect={() => save({
                type: "move_default_query",
                default_query_id: query.id,
                index: index + 1,
              })}
            >
              <ChevronDownIcon aria-hidden />
              {message("common.moveDown")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={state.mode === "readonly"}
              data-testid="default-query-remove"
              onSelect={() => save({
                type: "delete_default_query",
                default_query_id: query.id,
              })}
            >
              <Trash2Icon aria-hidden />
              {message("settings.removeDefaultQuery")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && (
        <div className="default-query-body" id={bodyId}>
          {plan ? (
            <QueryBuilder
              plan={plan}
              snapshot={state.snapshot}
              readonly={state.mode === "readonly"}
              onChange={commitPlan}
            />
          ) : (
            // A question written by a build that had a SPARQL editor. It still
            // runs and still says what it asks; what it no longer has is an
            // editor, so the reader's choices here are to read it or delete it.
            <pre className="query-compiled" data-testid="default-query-compiled">
              <code>{query.document.source}</code>
            </pre>
          )}
          {answer.error && (
            <p className="query-diagnostic" role="alert">
              {answer.error}
            </p>
          )}
          {/* The journal only reads this graph-owned document; Settings changes
              its presentation. Columns remain part of a table's question and
              disappear when the answer is read as a list. */}
          <div className="default-query-layout">
            <span className="field-label" id={`${bodyId}-layout`}>
              {message("settings.defaultQueryLayout")}
            </span>
            <div className="segmented" role="group" aria-labelledby={`${bodyId}-layout`}>
              {LAYOUTS.map((layout) => (
                <button
                  key={layout}
                  type="button"
                  aria-pressed={activeView.kind === layout}
                  disabled={state.mode === "readonly"}
                  data-testid={`default-query-layout-${layout}`}
                  onClick={() => save({
                    type: "put_query_view",
                    owner,
                    view: { ...activeView, kind: layout },
                  })}
                >
                  {message(layout === "list" ? "query.viewList" : "query.viewTable")}
                </button>
              ))}
            </div>
            {activeView.kind === "table" && plan && (
              <QueryColumnsControl
                choices={choices}
                onToggle={toggleColumn}
                onAggregate={summarizeColumn}
              />
            )}
          </div>
        </div>
      )}
    </li>
  );
}
