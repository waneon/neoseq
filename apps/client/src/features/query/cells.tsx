// How one result value reads.
//
// A SPARQL row is terms; a person reads pages, dates, tags and tasks. The
// difference is carried by the *column*, which knows what it asked the graph
// for — so a `builtin.task-deadline` cell prints a date in the reader's own
// journal format and a `tags` cell prints tag chips, while a hand-written query
// with no plan behind it falls back to plain terms.

import type { ReactNode } from "react";
import { CheckIcon, MinusIcon } from "lucide-react";
import type { QueryEntityRef, RdfTerm } from "../../generated/core-port";
import type { GraphSnapshot } from "../../core-port/snapshot";
import { findPage, findTag, journalDate, pageTitle } from "../../core-port/snapshot";
import { valueTypeOf } from "../../entities/properties";
import { LIST_SEPARATOR } from "../../entities/query-compile";
import type { PlanAggregate, PlanColumnSource } from "../../entities/query-plan";
import {
  TASK_PRIORITY_KEY,
  TASK_STATUS_KEY,
} from "../../entities/tasks";
import type { MessageFunction } from "../../i18n";
import { PriorityGlyph, TaskStatusGlyph } from "../tasks/glyphs";
import { priorityLabel, statusLabel } from "../tasks/labels";

/** One result row: the terms one solution bound, keyed by variable. */
export type ResultRow = Record<string, RdfTerm>;

/** One column of a result, as both views understand it. */
export interface ResultColumn {
  /** The SPARQL variable this column reads. */
  variable: string;
  label: string;
  /** What the plan asked for. Absent for a hand-written query. */
  source?: PlanColumnSource;
  aggregate?: PlanAggregate;
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
  /** Opens the thing a cell names. */
  onOpen?: (entity: QueryEntityRef) => void;
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
  if (!context.onOpen || entity.kind === "tag") return <span>{label}</span>;
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
}: {
  term: RdfTerm | undefined;
  column: ResultColumn;
  context: CellContext;
  /** The row's own entity, which makes its text cell the route to it. */
  subject?: QueryEntityRef;
}): ReactNode {
  // A row's text is its name, so it is also how the row is opened — a separate
  // column of entity ids would be a column nobody reads. A block with nothing
  // written in it still has to be reachable, so the route keeps a name of its
  // own where its text would be.
  if (column.source?.kind === "content" && subject && term?.kind === "literal") {
    const empty = term.value.trim().length === 0;
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
    return <span>{context.formatDate(term.value)}</span>;
  }
  return <span>{term.value}</span>;
}
