// How one result value reads.
//
// A SPARQL row is terms; a person reads pages, dates, tags and tasks. The
// difference is carried by the *column*, which knows what it asked the graph
// for — so a `builtin.task-deadline` cell prints the day in the pill every
// moment in this product wears, tinted by how far off it is, and a `tags` cell
// prints tag chips, while a hand-written query with no plan behind it falls back
// to plain terms.

import type { ReactNode } from "react";
import { CheckIcon, MinusIcon } from "lucide-react";
import type { QueryEntityRef, RdfTerm, SparqlQueryResult } from "../../generated/core-port";
import type { GraphSnapshot } from "../../core-port/snapshot";
import type { OrderSemantics } from "../../entities/query-ordering";
import {
  findBlock,
  findOutline,
  findPage,
  documentTitle,
  journalDate,
  outlineOwnerKey,
  pageTitle,
} from "../../core-port/snapshot";
import { valueTypeOf } from "../../entities/properties";
import type { PlanAggregate, PlanColumnSource } from "../../entities/query-plan";
import {
  isTaskDateKey,
  isTimeOfDay,
  TASK_PRIORITY_KEY,
  TASK_STATUS_KEY,
  type TaskDateKey,
} from "../../entities/tasks";
import type { MessageFunction } from "../../i18n";
import { PriorityGlyph, TaskStatusGlyph } from "../tasks/glyphs";
import { priorityLabel, statusLabel } from "../tasks/labels";
import { TaskMoment } from "../tasks/TaskMoment";
import { presentTaskMoment, type TaskMomentDuePresentation } from "../tasks/moment-presentation";
import { BlockMarkdown } from "../markdown/BlockMarkdown";
import { hasMarkdownSyntax } from "../markdown/profile";

/** Values preserve cardinality and entity identity through every renderer. */
export type ResultRow = Record<string, RdfTerm[]>;

/**
 * A result row with presentation identity separated from its RDF bindings.
 * The editor is keyed by the entity, never by the row's current position, so a
 * sort or query refresh cannot move a draft onto another block.
 */
export interface ResultViewRow {
  key: string;
  values: ResultRow;
  subject?: QueryEntityRef;
  subjectKey?: string;
}

/** One column of a result, as both views understand it. */
export interface ResultColumn {
  /** Stable authored column id, or a raw SPARQL variable. */
  variable: string;
  label: string;
  /** What the plan asked for. Absent for a hand-written query. */
  source?: PlanColumnSource;
  aggregate?: PlanAggregate;
  /** The result descriptor names the companion; renderers never invent one. */
  timeColumn?: string;
  /** The value's semantic order, kept separate from the words rendered below. */
  ordering: OrderSemantics;
  sortable: boolean;
  /** Numbers align to the end of their column; everything else to the start. */
  numeric: boolean;
  width: number | null;
}

export interface CellContext {
  snapshot: GraphSnapshot;
  message: MessageFunction;
  formatDate: (date: string) => string;
  /** The reader's own clock, so a moment reads here as it reads under a block. */
  formatTime: (time: string) => string;
  compare: (left: string, right: string) => number;
  /** Opens the thing a cell names. */
  onOpen?: (entity: QueryEntityRef) => void;
  /**
   * How far off a moment is — the step it falls in and the tone the reader chose
   * for that step — or `undefined` where the row has no urgency left to report.
   * The surface resolves it rather than the cell, because whether a row is
   * settled is a fact about the row and the thresholds are a preference; the
   * cell hands over the moment it is drawing, day and time both.
   */
  momentDue?: (
    date: string,
    time: string | undefined,
    row: ResultRow,
  ) => TaskMomentDuePresentation | null;
}

export function entityRefKey(entity: QueryEntityRef): string {
  return entity.kind === "block"
    ? `block:${outlineOwnerKey(entity.owner)}:${entity.id}`
    : `${entity.kind}:${entity.id}`;
}

/** Stable row ids for both renderers. Duplicate SPARQL solutions get a suffix. */
export function resultViewRows(
  result: Exclude<SparqlQueryResult, { kind: "ask" }>,
): ResultViewRow[] {
  const occurrences = new Map<string, number>();
  const rows =
    result.kind === "built"
      ? result.rows
      : result.rows.map((row) => ({
          subject: null,
          values: Object.fromEntries(Object.entries(row).map(([key, term]) => [key, [term]])),
        }));
  return rows.map(({ values, subject: entity }) => {
    const subject = entity ?? undefined;
    const subjectKey = subject ? entityRefKey(subject) : undefined;
    const terms = JSON.stringify(
      Object.entries(values).sort(([left], [right]) => left.localeCompare(right)),
    );
    const base = subjectKey ?? `terms:${terms}`;
    const occurrence = occurrences.get(base) ?? 0;
    occurrences.set(base, occurrence + 1);
    return {
      key: occurrence === 0 ? base : `${base}:${occurrence}`,
      values,
      subject,
      subjectKey,
    };
  });
}

const XSD_DATE = "http://www.w3.org/2001/XMLSchema#date";

/**
 * What a thing is called. A journal page is named by the reader's own date
 * format, any other page by its title, a tag by its name. A block is named by
 * its id only as a last resort — a query that shows blocks should also select
 * their text, which is what the outline-style list view does.
 */
export function entityName(entity: QueryEntityRef, context: CellContext): string {
  if (entity.kind === "tag") return documentTitle(context.snapshot, entity.id);
  if (entity.kind === "block") return entity.id;
  const page = findPage(context.snapshot, entity.id);
  if (!page) return documentTitle(context.snapshot, entity.id);
  const day = journalDate(page);
  return day ? context.formatDate(day) : pageTitle(page);
}

/** A number reads as a number: trailing zeros from `xsd:double` are noise. */
function formatNumber(value: string): string {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return value;
  return String(Math.round(parsed * 1e6) / 1e6);
}

function isNumericTerm(term: RdfTerm): boolean {
  return term.kind === "literal" && /#(double|decimal|integer|float|long|int)$/.test(term.datatype);
}

/** The plain reading of a term, with no column to interpret it. */
export function termText(term: RdfTerm | undefined, context: CellContext): string {
  if (!term) return "—";
  if (term.kind === "iri") {
    return term.entity ? entityName(term.entity, context) : term.value;
  }
  if (term.datatype === XSD_DATE) return context.formatDate(term.value);
  if (isNumericTerm(term)) return formatNumber(term.value);
  return term.value;
}

/**
 * The searchable, sortable text behind a cell — what the table sorts and filters
 * on, so the order a reader sees matches the words they see.
 */
export function cellText(
  terms: RdfTerm[] | undefined,
  column: ResultColumn,
  context: CellContext,
): string {
  return (terms ?? []).map((term) => cellTermText(term, column, context)).join(", ");
}

function cellTermText(term: RdfTerm, column: ResultColumn, context: CellContext): string {
  const key = column.source?.kind === "property" ? column.source.key : null;
  if (key === TASK_STATUS_KEY && term.kind === "literal") {
    return statusLabel(term.value, context.message);
  }
  if (key === TASK_PRIORITY_KEY && term.kind === "literal") {
    return priorityLabel(term.value, context.message);
  }
  return termText(term, context);
}

function EntityLink({
  entity,
  context,
  children,
  name,
}: {
  entity: QueryEntityRef;
  context: CellContext;
  children?: ReactNode;
  /** Names the route when what it shows is not a name — an empty block's cell. */
  name?: string;
}) {
  const label = children ?? entityName(entity, context);
  // A tag names a place now, so a tag cell follows like every other one.
  if (!context.onOpen) return <span>{label}</span>;
  return (
    <button
      type="button"
      className="query-link"
      aria-label={name}
      onClick={() => context.onOpen?.(entity)}
    >
      {label}
    </button>
  );
}

/** A cell, rendered by what its column asked the graph for. */
export function CellValue({
  terms,
  column,
  context,
  subject,
  row,
}: {
  terms: RdfTerm[] | undefined;
  column: ResultColumn;
  context: CellContext;
  /** The row's own entity, which lets the result layer route or edit it. */
  subject?: QueryEntityRef;
  /**
   * The row this cell is one of. A moment reads by how far off it is, and
   * whether there is any urgency left to report is a fact about the row.
   */
  row?: ResultRow;
}): ReactNode {
  if (!terms?.length) return <span className="query-empty-cell">—</span>;
  if (column.source?.kind === "tags" && !column.aggregate) {
    return (
      <span className="query-tags">
        {terms.map((term, index) => (
          <span key={index} className="query-tag-chip">
            {term.kind === "iri" && term.entity ? (
              <EntityLink entity={term.entity} context={context} />
            ) : (
              termText(term, context)
            )}
          </span>
        ))}
      </span>
    );
  }
  return terms.map((term, index) => (
    <span key={index} className="query-value">
      {index > 0 && ", "}
      <TermValue term={term} column={column} context={context} subject={subject} row={row} />
    </span>
  ));
}

function TermValue({
  term,
  column,
  context,
  subject,
  row,
}: {
  term: RdfTerm;
  column: ResultColumn;
  context: CellContext;
  subject?: QueryEntityRef;
  row?: ResultRow;
}): ReactNode {
  // A row's text is its name. The result layer may wrap it with an editor and a
  // separate open control; the plain renderer remains a route. A block with
  // nothing written in it still needs an accessible name of its own.
  if (column.source?.kind === "content" && subject && term?.kind === "literal") {
    const empty = term.value.trim().length === 0;
    const outline =
      subject.kind === "block" ? findOutline(context.snapshot, subject.owner) : undefined;
    const block = outline ? findBlock(outline, subject.id) : undefined;
    const pageReferences = block?.markdown === term.value ? block.page_references : [];
    if (hasMarkdownSyntax(term.value, pageReferences.length > 0)) {
      return (
        <BlockMarkdown
          markdown={term.value}
          pageReferences={pageReferences}
          graphId={context.snapshot.graph_id}
          variant="compact"
        />
      );
    }
    return (
      <EntityLink
        entity={subject}
        context={context}
        name={empty ? context.message("query.openEmptyResult") : undefined}
      >
        {empty ? <span className="query-empty-cell">—</span> : term.value}
      </EntityLink>
    );
  }
  if (column.aggregate === "count" || column.aggregate === "sum" || column.aggregate === "avg") {
    return <span className="query-num">{term ? formatNumber(term.value) : "0"}</span>;
  }

  const key = column.source?.kind === "property" ? column.source.key : null;
  if (key === TASK_STATUS_KEY && term.kind === "literal") {
    return (
      <span className="query-status">
        <TaskStatusGlyph status={term.value} />
        {statusLabel(term.value, context.message)}
      </span>
    );
  }
  if (key === TASK_PRIORITY_KEY && term.kind === "literal") {
    return (
      <span className="query-status">
        <PriorityGlyph priority={term.value} />
        {priorityLabel(term.value, context.message)}
      </span>
    );
  }
  // A moment is a bubble tinted by how far off it is — the same object the strip
  // under a block draws, so `Scheduled` reads the same whether the reader met it
  // in the outline or in a column of a table (designs/metadata.md § Moments).
  // The exact date and optional time remain written in full, so the tone is not
  // the only record of the fact. No glyph: the heading already names the moment.
  if (key && isTaskDateKey(key) && term.kind === "literal" && term.datatype === XSD_DATE) {
    return <DueValue taskKey={key} date={term.value} column={column} context={context} row={row} />;
  }
  if (key && valueTypeOf(key) === "checkbox" && term.kind === "literal") {
    const checked = term.value === "true";
    return (
      <span className="query-check" data-checked={checked}>
        {checked ? <CheckIcon aria-hidden /> : <MinusIcon aria-hidden />}
        {checked ? context.message("properties.checked") : context.message("properties.unchecked")}
      </span>
    );
  }
  if (term.kind === "iri" && term.entity) {
    return <EntityLink entity={term.entity} context={context} />;
  }
  if (isNumericTerm(term)) return <span className="query-num">{formatNumber(term.value)}</span>;
  if (term.kind === "literal" && term.datatype === XSD_DATE) {
    return <span className="query-date">{context.formatDate(term.value)}</span>;
  }
  return <span>{term.value}</span>;
}

/**
 * One moment, as the object it is everywhere else in the product: the day, the
 * time of day where there is one, in a pill the tone of how far off it is.
 *
 * The time is not a column of its own and never was — it rides along with the
 * day's column through its result descriptor, because
 * a moment is a day plus an optional time and half of one is not a moment. That
 * also makes the tier here the *moment's*: a job due at nine this morning is
 * overdue by ten, and receives the same overdue tone as it does in the outline.
 */
function DueValue({
  taskKey,
  date,
  column,
  context,
  row,
}: {
  taskKey: TaskDateKey;
  date: string;
  column: ResultColumn;
  context: CellContext;
  row?: ResultRow;
}) {
  const companion = column.timeColumn ? row?.[column.timeColumn]?.[0] : undefined;
  // A stored time that is not one is the reader's own string: it does not
  // refine the day and it does not get drawn as if it did.
  const time =
    companion?.kind === "literal" && isTimeOfDay(companion.value) ? companion.value : undefined;
  const value = presentTaskMoment({
    key: taskKey,
    date,
    time,
    due: row ? (context.momentDue?.(date, time, row) ?? null) : null,
    repeating: false,
    message: context.message,
    formatDate: context.formatDate,
    formatTime: context.formatTime,
  });
  // A column is narrow, so the shared cell appearance keeps the whole value in
  // its title while allowing the written day to ellipsise.
  return <TaskMoment value={value} appearance="cell" />;
}
