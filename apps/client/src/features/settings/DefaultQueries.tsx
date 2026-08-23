// Where a journal's standing questions are written.
//
// The journal reads them and this writes them, which is the whole shape of the
// feature: a standing question is set up once and then read every day, so its
// editor belongs where the reader's other preferences are and not parked under
// the writing it sits below (§ Do / Don't — nothing below the outline is chrome).
//
// **A row states the question, not the machinery.** Its caption is the same
// phrase the journal will print above the answer, and beside it the same count
// the journal will print beside it — so the row is a preview at the size it will
// render, which is what every other choice in this dialog owes the reader. A
// broken query says so here, where it can be fixed, and not only there.
//
// **Two entrances, the same two the outline has.** `/` offers a built query and
// hand-written SPARQL; so does this. Nothing here is a second authoring grammar:
// the builder is the product's own, and what it compiles is stored beside the
// plan exactly as the graph stores its own queries.

import { useEffect, useId, useMemo, useState } from "react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  CodeIcon,
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
  addDefaultQuery,
  defaultQueryKey,
  MAX_DEFAULT_QUERIES,
  MAX_DEFAULT_QUERY_TITLE,
  moveDefaultQuery,
  putDefaultQuery,
  removeDefaultQuery,
  type DefaultQuery,
} from "../../entities/default-queries";
import { todayLocalDate } from "../../entities/journal";
import { compilePlan, planBindings, QUERY_LANGUAGE } from "../../entities/query-compile";
import {
  decodePlan,
  defaultPlan,
  encodePlan,
  QUERY_PLAN_VERSION,
  type QueryPlan,
} from "../../entities/query-plan";
import { useQueryAnswer } from "../query/execution";
import { answerLabel } from "../query/labels";
import { QueryBuilder } from "../query/QueryBuilder";
import { planSummary, summaryLabel } from "../query/summary";
import { useSessionState } from "../shell/session-context";
import { useI18n } from "../../i18n";
import { useDefaultQueries } from "./preferences";

/** The two layouts a journal may read an answer through. */
const LAYOUTS: QueryViewKind[] = ["list", "table"];

export function DefaultQueriesSection() {
  const { message } = useI18n();
  const queries = useDefaultQueries();
  // One editor at a time. A builder is five rows tall, and eight of them open at
  // once turns a pane that scrolls into a pane that only scrolls.
  const [openId, setOpenId] = useState<string | null>(null);
  const full = queries.length >= MAX_DEFAULT_QUERIES;

  /** A new query opens on itself: adding one and not landing on it says nothing. */
  const create = (plan: QueryPlan | null) => {
    const created = addDefaultQuery(plan
      ? {
          title: "",
          plan: { version: QUERY_PLAN_VERSION, payload: encodePlan(plan) },
          source: compilePlan(plan).source,
          layout: "list",
        }
      : { title: "", source: "", layout: "list" });
    if (created) setOpenId(created.id);
  };

  return (
    <section className="settings-section">
      <h2>{message("settings.defaultQueries")}</h2>
      <p>{message("settings.defaultQueriesDescription")}</p>
      {queries.length > 0 && (
        <ul className="default-queries" data-testid="settings-default-queries">
          {queries.map((query, index) => (
            <DefaultQueryRow
              key={query.id}
              query={query}
              open={openId === query.id}
              first={index === 0}
              last={index === queries.length - 1}
              onOpen={(open) => setOpenId(open ? query.id : null)}
            />
          ))}
        </ul>
      )}
      {/* The empty state *is* the action, so these two are the section's own
          floor rather than a row that appears once something else exists. */}
      <div className="default-query-add">
        <button
          type="button"
          className="btn"
          disabled={full}
          data-testid="add-default-query"
          onClick={() => create(defaultPlan("block"))}
        >
          <PlusIcon aria-hidden />
          {message("settings.addDefaultQuery")}
        </button>
        <button
          type="button"
          className="btn"
          disabled={full}
          data-testid="add-default-sparql"
          onClick={() => create(null)}
        >
          <CodeIcon aria-hidden />
          {message("settings.addDefaultSparql")}
        </button>
      </div>
      {/* A disabled pair of buttons has to say what would re-enable them. */}
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
  onOpen,
}: {
  query: DefaultQuery;
  open: boolean;
  first: boolean;
  last: boolean;
  onOpen: (open: boolean) => void;
}) {
  const state = useSessionState();
  const { message, formatJournalDate } = useI18n();
  const bodyId = useId();
  // The payload, not the record: every write rebuilds the stored object, so a
  // memo keyed on its identity would recompile the plan on each keystroke of the
  // name beside it.
  const payload = query.plan?.payload;
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
    source: compiled ? compiled.source : query.source,
    bindings: compiled ? planBindings(compiled.parameters, runtime) : {},
  }), [compiled, query.source, runtime]);
  const answer = useQueryAnswer(defaultQueryKey(query), request);
  const count = answerLabel(answer, null, message);

  // The authoritative source is the truth after another window edited it; the
  // draft is the truth while the reader is typing SPARQL into it. Committing on
  // blur rather than per keystroke keeps a half-written query from spending the
  // pause between two words as a parse error.
  const [draft, setDraft] = useState(query.source);
  useEffect(() => setDraft(query.source), [query.source]);

  const summary = plan
    ? planSummary(plan, {
        snapshot: state.snapshot,
        message,
        formatDate: formatJournalDate,
      })
    : { lead: "SPARQL", detail: null };
  const name = query.title || summaryLabel(summary);

  const commitSource = () => {
    if (draft !== query.source) putDefaultQuery({ ...query, source: draft });
  };

  /** A plan and the SPARQL it compiles to are written together, never apart. */
  const commitPlan = (next: QueryPlan) => {
    putDefaultQuery({
      ...query,
      plan: { version: QUERY_PLAN_VERSION, payload: encodePlan(next) },
      source: compilePlan(next).source,
    });
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
          onChange={(event) => putDefaultQuery({ ...query, title: event.target.value })}
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
              disabled={first}
              data-testid="default-query-up"
              onSelect={() => moveDefaultQuery(query.id, -1)}
            >
              <ChevronUpIcon aria-hidden />
              {message("common.moveUp")}
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={last}
              data-testid="default-query-down"
              onSelect={() => moveDefaultQuery(query.id, 1)}
            >
              <ChevronDownIcon aria-hidden />
              {message("common.moveDown")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              data-testid="default-query-remove"
              onSelect={() => removeDefaultQuery(query.id)}
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
              readonly={false}
              onChange={commitPlan}
            />
          ) : (
            <textarea
              className="query-source"
              value={draft}
              spellCheck={false}
              aria-label={message("query.source")}
              data-testid="default-query-source"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commitSource}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                  event.preventDefault();
                  commitSource();
                  answer.run(true);
                }
              }}
            />
          )}
          {answer.error && (
            <p className="query-diagnostic" role="alert">
              {answer.error}
            </p>
          )}
          {/* The one presentation choice the journal cannot make for itself:
              there is no document under a default query for a reader to write a
              layout into, so it is written here. */}
          <div className="default-query-layout">
            <span className="field-label" id={`${bodyId}-layout`}>
              {message("settings.defaultQueryLayout")}
            </span>
            <div className="segmented" role="group" aria-labelledby={`${bodyId}-layout`}>
              {LAYOUTS.map((layout) => (
                <button
                  key={layout}
                  type="button"
                  aria-pressed={query.layout === layout}
                  data-testid={`default-query-layout-${layout}`}
                  onClick={() => putDefaultQuery({ ...query, layout })}
                >
                  {message(layout === "list" ? "query.viewList" : "query.viewTable")}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}
