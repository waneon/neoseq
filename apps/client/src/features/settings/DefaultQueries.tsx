// Where a journal's standing questions are written.
//
// The journal reads them and this writes them, which is the whole shape of the
// feature: a standing question is set up once and then read every day, so its
// editor belongs with this graph's other settings and not parked under the
// writing it sits below (designs/query.md § One Document, Different Contexts).
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
// returns here too, because those columns are part of the question; the saved
// view can then be shaped wherever its answer is read.
//
// **The list is read; one question is edited.** Rows are one line each — the
// name, the question beneath it when named, and the count — and opening one
// lays its name, conditions and layout out below it. Here the conditions are the
// point of opening it, so they are always shown; folding them is the journal's.

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
import { Button } from "@/ui/shadcn/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import type { QueryViewKind } from "../../core-port/snapshot";
import type { AuthoredQueryRequest } from "../../generated/core-port";
import {
  defaultQueryKey,
  MAX_DEFAULT_QUERIES,
  MAX_DEFAULT_QUERY_TITLE,
  newDefaultQueryDocument,
  type DefaultQuery,
} from "../../entities/default-queries";
import { useToday } from "../time/use-local-clock";
import { QUERY_LANGUAGE } from "../../entities/query-document";
import {
  columnSourceKey,
  columnSourcesFor,
  decodePlan,
  defaultPlan,
  encodePlan,
  graphPropertyKeys,
  QUERY_PLAN_VERSION,
  withColumn,
  withoutColumn,
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
import { useSession, useSessionSelector } from "../shell/session-context";
import { useDeferredCommand } from "../shell/deferred-command";
import { useI18n } from "../../i18n";
import { randomUUID } from "@/lib/crypto";

/** The two layouts a journal may read an answer through. */
const LAYOUTS: QueryViewKind[] = ["list", "table"];

export function DefaultQueriesSection() {
  const { message } = useI18n();
  const session = useSession();
  const state = useSessionSelector(
    (current) => current,
    (left, right) => left.snapshot === right.snapshot && left.mode === right.mode,
  );
  const notify = useNotify();
  const queries = state.snapshot.settings.default_queries;
  // One editor at a time. A builder is five rows tall, and eight of them open at
  // once turns a pane that scrolls into a pane that only scrolls.
  const [openId, setOpenId] = useState<string | null>(null);
  const full = queries.length >= MAX_DEFAULT_QUERIES;

  /** A new query opens on itself: adding one and not landing on it says nothing. */
  const create = (plan: QueryPlan) => {
    const id = `dq-${randomUUID()}`;
    void session
      .execute({
        type: "create_default_query",
        default_query_id: id,
        title: "",
        document: newDefaultQueryDocument(
          "",
          { version: QUERY_PLAN_VERSION, payload: encodePlan(plan) },
          "list",
        ),
      })
      .then(() => setOpenId(id))
      .catch((cause: unknown) => {
        notify.failure(message("failure.saveQuery"), cause);
      });
  };

  return (
    <section className="settings-section">
      <div className="default-queries" data-testid="settings-default-queries">
        {queries.length === 0 && (
          <p className="default-queries-empty">{message("settings.emptyQueries")}</p>
        )}
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
        {/* The list's own last row, so adding is where the next one will be. */}
        <button
          type="button"
          className="default-query-add"
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
  const state = useSessionSelector(
    (current) => current,
    (left, right) => left.snapshot === right.snapshot && left.mode === right.mode,
  );
  const notify = useNotify();
  const { message, formatJournalDate } = useI18n();
  const bodyId = useId();
  // The payload, not the record: every write rebuilds the stored object, so a
  // memo keyed on its identity would recompile the plan on each keystroke of the
  // name beside it.
  const activeView =
    query.document.views.find((view) => view.id === query.document.default_view_id) ??
    query.document.views[0]!;
  const storedPlan = activeView.definition.plan;
  const savedPlan = useMemo(
    () => (storedPlan ? decodePlan(storedPlan.payload, storedPlan.version) : null),
    [storedPlan],
  );
  // Typing edits these drafts; the graph hears of them after a pause, so a
  // keystroke never waits on a round trip that would overwrite the next one.
  const [planDraft, setPlanDraft] = useState<QueryPlan | null>(null);
  const [titleDraft, setTitleDraft] = useState<string | null>(null);
  const plan = planDraft ?? savedPlan;
  const title = titleDraft ?? query.title;
  const planDraftPayload = planDraft && encodePlan(planDraft);
  useEffect(() => {
    if (planDraftPayload !== null && planDraftPayload === storedPlan?.payload) setPlanDraft(null);
  }, [planDraftPayload, storedPlan?.payload]);
  useEffect(() => {
    if (titleDraft === query.title) setTitleDraft(null);
  }, [titleDraft, query.title]);
  const unsupportedPlan = storedPlan != null && plan === null;
  const today = useToday();
  // The same request the journal will make, so the two share one execution: the
  // count here is the count there rather than a second opinion about it.
  const request = useMemo<AuthoredQueryRequest | null>(
    () =>
      plan
        ? { kind: "built", plan, today }
        : unsupportedPlan
          ? null
          : {
              kind: "raw_sparql",
              language: QUERY_LANGUAGE,
              source: activeView.definition.source,
            },
    [activeView.definition.source, plan, today, unsupportedPlan],
  );
  const answer = useQueryAnswer(
    JSON.stringify([defaultQueryKey(query), activeView.id]),
    request,
    unsupportedPlan ? message("query.unsupportedPlan") : null,
  );
  const count = answerLabel(answer, null, message);

  const summary = plan
    ? planSummary(plan, {
        snapshot: state.snapshot,
        message,
        formatDate: formatJournalDate,
      })
    : unsupportedPlan
      ? { lead: message("query.unsupportedPlan"), detail: null }
      : { lead: "SPARQL", detail: null };
  const name = title || summaryLabel(summary);

  const owner = { kind: "graph_default", default_query_id: query.id } as const;
  const executeCommand = (command: Parameters<typeof session.execute>[0]): Promise<void> =>
    session
      .execute(command)
      .then(() => undefined)
      .catch((cause: unknown) => {
        notify.failure(message("failure.saveQuery"), cause);
      });
  const save = (command: Parameters<typeof session.execute>[0]): void => {
    void executeCommand(command);
  };
  const saveFailed = (cause: unknown) => notify.failure(message("failure.saveQuery"), cause);
  useDeferredCommand(
    planDraftPayload !== null && planDraftPayload !== storedPlan?.payload
      ? {
          type: "set_query_plan",
          owner,
          view_id: activeView.id,
          plan: { version: QUERY_PLAN_VERSION, payload: planDraftPayload },
        }
      : null,
    `plan:${query.id}:${activeView.id}`,
    saveFailed,
  );
  useDeferredCommand(
    titleDraft !== null && titleDraft !== query.title
      ? { type: "rename_default_query", default_query_id: query.id, title: titleDraft }
      : null,
    `title:${query.id}`,
    saveFailed,
  );
  /** The plan is authority; its marked SPARQL is regenerated beside it. */
  const commitPlan = (next: QueryPlan): Promise<void> => {
    setPlanDraft(null);
    return executeCommand({
      type: "set_query_plan",
      owner,
      view_id: activeView.id,
      plan: { version: QUERY_PLAN_VERSION, payload: encodePlan(next) },
    });
  };

  const hiddenVariables = new Set(
    activeView.columns.filter((column) => column.hidden).map((column) => column.variable),
  );
  // Settings authors which columns the query returns. A presented answer may
  // hide one only in its saved view, so the same switch also reads and restores
  // that state instead of claiming the hidden column is still shown.
  const choices = plan
    ? columnChoices(
        columnSourcesFor(plan.subject, graphPropertyKeys(state.snapshot)),
        plan.columns,
        new Set(
          plan.columns
            .filter((column) => hiddenVariables.has(column.id))
            .map((column) => columnSourceKey(column.source)),
        ),
        plan.subject,
        message,
      )
    : [];

  const toggleColumn = (choice: ColumnChoice, shown: boolean) => {
    if (!plan) return;
    if (shown) {
      if (!choice.column) {
        void commitPlan(withColumn(plan, choice.source));
        return;
      }
      const variable = choice.column.id;
      if (hiddenVariables.has(variable)) {
        save({
          type: "put_query_view",
          owner,
          view: {
            ...activeView,
            columns: activeView.columns.map((column) =>
              column.variable === variable ? { ...column, hidden: false } : column,
            ),
          },
        });
      }
      return;
    }
    if (!choice.column) return;
    const next = withoutColumn(plan, choice.column.id);
    if (next === plan) return;
    const variable = choice.column.id;
    void (async () => {
      await commitPlan(next);
      if (activeView.columns.some((column) => column.variable === variable)) {
        await executeCommand({
          type: "put_query_view",
          owner,
          view: {
            ...activeView,
            columns: activeView.columns.filter((column) => column.variable !== variable),
          },
        });
      }
    })();
  };

  const question = summaryLabel(summary);
  const readonly = state.mode === "readonly";
  return (
    <div className="default-query" data-open={open || undefined}>
      <div className="default-query-head">
        <button
          type="button"
          className="default-query-summary"
          aria-expanded={open}
          aria-controls={open ? bodyId : undefined}
          data-testid="default-query-disclose"
          onClick={() => onOpen(!open)}
        >
          <ChevronRightIcon className="default-query-chevron" aria-hidden />
          <span className="default-query-text">
            <span className="default-query-name">{name}</span>
            {/* Named, the question still says what it asks. */}
            {title && <span className="default-query-question">{question}</span>}
          </span>
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
        </button>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="icon"
              variant="ghost"
              className="default-query-actions"
              aria-label={message("settings.defaultQueryActions", { name })}
              disabled={readonly}
              data-testid="default-query-actions"
            >
              <MoreHorizontalIcon aria-hidden />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {/* Order is the order they are read in, and a list this short is
                ordered by saying so — the drag a longer list would earn buys
                nothing a phone or a keyboard can use. */}
            <DropdownMenuItem
              disabled={first || readonly}
              data-testid="default-query-up"
              onSelect={() =>
                save({
                  type: "move_default_query",
                  default_query_id: query.id,
                  index: index - 1,
                })
              }
            >
              <ChevronUpIcon aria-hidden />
              {message("common.moveUp")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={last || readonly}
              data-testid="default-query-down"
              onSelect={() =>
                save({
                  type: "move_default_query",
                  default_query_id: query.id,
                  index: index + 1,
                })
              }
            >
              <ChevronDownIcon aria-hidden />
              {message("common.moveDown")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              disabled={readonly}
              data-testid="default-query-remove"
              onSelect={() =>
                save({
                  type: "delete_default_query",
                  default_query_id: query.id,
                })
              }
            >
              <Trash2Icon aria-hidden />
              {message("settings.removeDefaultQuery")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {open && (
        <div className="default-query-editor" id={bodyId}>
          {/* The name is the one thing here written in the reader's own words.
              Empty, it shows the question itself — which is also what the
              journal captions the answer with. */}
          <div className="default-query-field">
            <label className="settings-field-label" htmlFor={`${bodyId}-name`}>
              {message("settings.defaultQueryName")}
            </label>
            <Input
              id={`${bodyId}-name`}
              value={title}
              placeholder={question}
              maxLength={MAX_DEFAULT_QUERY_TITLE}
              data-testid="default-query-title"
              disabled={readonly}
              onChange={(event) => setTitleDraft(event.target.value)}
            />
          </div>
          {/* The builder names its own parts; a label above it would repeat them. */}
          <div className="default-query-field">
            {plan ? (
              <QueryBuilder
                id={`${bodyId}-conditions`}
                plan={plan}
                snapshot={state.snapshot}
                readonly={readonly}
                onChange={setPlanDraft}
              />
            ) : (
              // A question written by a build that had a SPARQL editor. It still
              // runs and still says what it asks; what it no longer has is an
              // editor, so the reader's choices here are to read it or delete it.
              <pre className="query-compiled" data-testid="default-query-compiled">
                <code>{activeView.definition.source}</code>
              </pre>
            )}
            {answer.error && (
              <p className="query-diagnostic" role="alert">
                {answer.error}
              </p>
            )}
          </div>
          {/* Settings authors the projection and may choose its initial layout;
              the journal may shape the current saved view without changing the
              question. Columns remain part of a table's question and disappear
              when the answer is read as a list. */}
          <div className="default-query-field">
            <span className="settings-field-label" id={`${bodyId}-layout`}>
              {message("settings.defaultQueryLayout")}
            </span>
            <div className="default-query-layout">
              <div className="segmented" role="group" aria-labelledby={`${bodyId}-layout`}>
                {LAYOUTS.map((layout) => (
                  <button
                    key={layout}
                    type="button"
                    aria-pressed={activeView.kind === layout}
                    disabled={readonly}
                    data-testid={`default-query-layout-${layout}`}
                    onClick={() =>
                      save({
                        type: "put_query_view",
                        owner,
                        view: { ...activeView, kind: layout },
                      })
                    }
                  >
                    {message(layout === "list" ? "query.viewList" : "query.viewTable")}
                  </button>
                ))}
              </div>
              {activeView.kind === "table" && plan && (
                <QueryColumnsControl choices={choices} onToggle={toggleColumn} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
