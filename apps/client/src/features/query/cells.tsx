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
import type { QueryEntityRef, RdfTerm } from "../../generated/core-port";
import type { GraphSnapshot } from "../../core-port/snapshot";
import type { OrderSemantics } from "../../entities/query-ordering";
import {
  findPage,
  findTag,
  journalDate,
  outlineOwnerKey,
  pageTitle,
} from "../../core-port/snapshot";
import { valueTypeOf } from "../../entities/properties";
import { LIST_SEPARATOR, momentTimeVariable } from "../../entities/query-compile";
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
import {
  presentTaskMoment,
  type TaskMomentDuePresentation,
} from "../tasks/moment-presentation";
import { BlockMarkdown } from "../markdown/BlockMarkdown";
import { hasMarkdownSyntax } from "../markdown/profile";

/** One result row: the terms one solution bound, keyed by variable. */
export type ResultRow = Record<string, RdfTerm>;

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
  /** The SPARQL variable this column reads. */
  variable: string;
  label: string;
  /** What the plan asked for. Absent for a hand-written query. */
  source?: PlanColumnSource;
  aggregate?: PlanAggregate;
  /** The value's semantic order, kept separate from the words rendered below. */
  ordering: OrderSemantics;
  sortable: boolean;
  /** Numbers align to the end of their column; everything else to the start. */
  numeric: boolean;
  width: number | null;
}

export interface CellContext {
  snapshot: GraphSnapshot;
  /** The result variable carrying which thing each row is, when there is one. */
  subjectVariable?: string | null;
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
export function resultViewRows(rows: ResultRow[], context: CellContext): ResultViewRow[] {
  const occurrences = new Map<string, number>();
  return rows.map((values) => {
    const subject = rowSubject(values, context);
    const subjectKey = subject ? entityRefKey(subject) : undefined;
    const terms = Object.entries(values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([variable, term]) => `${variable}:${term.kind}:${term.value}`)
      .join("|");
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
  if (entity.kind === "tag") return findTag(context.snapshot, entity.id)?.name ?? entity.id;
  if (entity.kind === "block") return entity.id;
  const page = findPage(context.snapshot, entity.id);
  if (!page) return entity.id;
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
  term: RdfTerm | undefined,
  column: ResultColumn,
  context: CellContext,
): string {
  if (!term) return "";
  if (column.aggregate === "list" || column.source?.kind === "tags") {
    return splitList(term).join(", ");
  }
  const key = column.source?.kind === "property" ? column.source.key : null;
  if (key === TASK_STATUS_KEY && term.kind === "literal") {
    return statusLabel(term.value, context.message);
  }
  if (key === TASK_PRIORITY_KEY && term.kind === "literal") {
    return priorityLabel(term.value, context.message);
  }
  return termText(term, context);
}

function splitList(term: RdfTerm): string[] {
  if (term.kind !== "literal" || term.value.length === 0) return [];
  return term.value.split(LIST_SEPARATOR).filter((member) => member.length > 0);
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

/** The entity a result row is about, when the query carries one. */
export function rowSubject(row: ResultRow, context: CellContext): QueryEntityRef | undefined {
  if (!context.subjectVariable) return undefined;
  const term = row[context.subjectVariable];
  return term?.kind === "iri" ? term.entity ?? undefined : undefined;
}

/** A cell, rendered by what its column asked the graph for. */
export function CellValue({
  term,
  column,
  context,
  subject,
  row,
}: {
  term: RdfTerm | undefined;
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
  // A row's text is its name. The result layer may wrap it with an editor and a
  // separate open control; the plain renderer remains a route. A block with
  // nothing written in it still needs an accessible name of its own.
  if (column.source?.kind === "content" && subject && term?.kind === "literal") {
    const empty = term.value.trim().length === 0;
    const content = hasMarkdownSyntax(term.value)
      ? <BlockMarkdown markdown={term.value} variant="compact" />
      : term.value;
    return (
      <EntityLink
        entity={subject}
        context={context}
        name={empty ? context.message("query.openEmptyResult") : undefined}
      >
        {empty ? <span className="query-empty-cell">—</span> : content}
      </EntityLink>
    );
  }
  if (column.aggregate && column.aggregate !== "list") {
    return <span className="query-num">{term ? formatNumber(term.value) : "0"}</span>;
  }
  const folded = column.aggregate === "list" || column.source?.kind === "tags";
  if (folded) {
    const members = term ? splitList(term) : [];
    if (members.length === 0) return <span className="query-empty-cell">—</span>;
    if (column.source?.kind === "tags") {
      return (
        <span className="query-tags">
          {members.map((name) => (
            <span key={name} className="query-tag-chip">{name}</span>
          ))}
        </span>
      );
    }
    return <span>{members.join(", ")}</span>;
  }
  if (!term) return <span className="query-empty-cell">—</span>;

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
    return (
      <DueValue
        taskKey={key}
        date={term.value}
        column={column}
        context={context}
        row={row}
      />
    );
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
 * day's column in the compiler's own namespace (§ momentTimeVariable), because
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
  const companion = row?.[momentTimeVariable(column.variable)];
  // A stored time that is not one is the reader's own string: it does not
  // refine the day and it does not get drawn as if it did.
  const time = companion?.kind === "literal" && isTimeOfDay(companion.value)
    ? companion.value
    : undefined;
  const value = presentTaskMoment({
    key: taskKey,
    date,
    time,
    due: row ? context.momentDue?.(date, time, row) ?? null : null,
    repeating: false,
    message: context.message,
    formatDate: context.formatDate,
    formatTime: context.formatTime,
  });
  // A column is narrow, so the shared cell appearance keeps the whole value in
  // its title while allowing the written day to ellipsise.
  return <TaskMoment value={value} appearance="cell" />;
}
