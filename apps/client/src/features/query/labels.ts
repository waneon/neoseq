// The words the builder speaks.
//
// A plan is stored in the vocabulary of the RDF projection; a person reads it in
// the vocabulary of the product. Every name a builder row prints comes from
// here, so a field can never be called two different things — and property keys
// go through the same `property-display` module as every other surface.

import type { QueryView } from "../../core-port/snapshot";
import type { MessageFunction } from "../../i18n";
import { TASK_PRIORITY_KEY, TASK_STATUS_KEY } from "../../entities/tasks";
import { propertyDisplayName } from "../properties/property-display";
import { priorityLabel, statusLabel } from "../tasks/labels";
import type {
  PlanAggregate,
  PlanColumn,
  PlanColumnSource,
  PlanField,
  PlanFieldKind,
  PlanMatch,
  PlanOperator,
  PlanRelativeDate,
  PlanSubject,
} from "../../entities/query-plan";

/**
 * A view's name. The one a document is born with is the product's own word in the
 * reader's language — and `table`/`list` are the two a document born before that
 * carried, kept so their names still read as words rather than as English left
 * behind. Every view after them was named by somebody, and a name somebody typed
 * is never translated out from under them.
 */
export function viewLabel(view: QueryView, message: MessageFunction): string {
  if (view.id === "all") return message("query.viewAll");
  if (view.id === "table") return message("query.viewTable");
  if (view.id === "list") return message("query.viewList");
  return view.name;
}

export function subjectLabel(subject: PlanSubject, message: MessageFunction): string {
  return message(`query.subject.${subject}` as
    | "query.subject.block"
    | "query.subject.page"
    | "query.subject.tag");
}

export function matchLabel(match: PlanMatch, message: MessageFunction): string {
  return message(`query.match.${match}` as
    | "query.match.all"
    | "query.match.any"
    | "query.match.none");
}

/** `content` is named after the subject it belongs to: text, title, or name. */
export function fieldKindLabel(
  kind: PlanFieldKind,
  subject: PlanSubject,
  message: MessageFunction,
): string {
  if (kind === "content") {
    if (subject === "page") return message("query.field.title");
    if (subject === "tag") return message("query.field.name");
    return message("query.field.text");
  }
  return message(`query.field.${kind}` as
    | "query.field.property"
    | "query.field.tag"
    | "query.field.page"
    | "query.field.ancestor"
    | "query.field.sibling_index");
}

export function fieldLabel(
  field: PlanField,
  subject: PlanSubject,
  message: MessageFunction,
): string {
  if (field.kind === "property") return propertyDisplayName(field.key, message);
  return fieldKindLabel(field.kind, subject, message);
}

export function operatorLabel(op: PlanOperator, message: MessageFunction): string {
  return message(`query.op.${op}` as `query.op.${typeof op}`);
}

/** A stored choice reads the way its own feature writes it, never as raw text. */
export function choiceLabel(key: string, choice: string, message: MessageFunction): string {
  if (key === TASK_STATUS_KEY) return statusLabel(choice, message);
  if (key === TASK_PRIORITY_KEY) return priorityLabel(choice, message);
  return choice;
}

export function columnSourceLabel(
  source: PlanColumnSource,
  subject: PlanSubject,
  message: MessageFunction,
): string {
  if (source.kind === "property") return propertyDisplayName(source.key, message);
  if (source.kind === "subject") return subjectLabel(subject, message);
  if (source.kind === "content") return fieldKindLabel("content", subject, message);
  return message(`query.column.${source.kind}` as
    | "query.column.tags"
    | "query.column.page"
    | "query.column.parent"
    | "query.column.sibling_index");
}

export function aggregateLabel(aggregate: PlanAggregate, message: MessageFunction): string {
  return message(`query.aggregate.${aggregate}` as `query.aggregate.${typeof aggregate}`);
}

/** A column's heading: the user's own word when they gave one. */
export function columnLabel(
  column: PlanColumn,
  subject: PlanSubject,
  message: MessageFunction,
): string {
  if (column.label && column.label.trim().length > 0) return column.label;
  const base = columnSourceLabel(column.source, subject, message);
  if (!column.aggregate) return base;
  return message("query.aggregateOf", {
    aggregate: aggregateLabel(column.aggregate, message),
    field: base,
  });
}

/** The relative days the date editor offers, in the order it offers them. */
export const RELATIVE_DATE_PRESETS: { id: string; value: PlanRelativeDate }[] = [
  { id: "today", value: { unit: "day", offset: 0 } },
  { id: "tomorrow", value: { unit: "day", offset: 1 } },
  { id: "yesterday", value: { unit: "day", offset: -1 } },
  { id: "in7", value: { unit: "day", offset: 7 } },
  { id: "ago7", value: { unit: "day", offset: -7 } },
  { id: "in30", value: { unit: "day", offset: 30 } },
  { id: "weekStart", value: { unit: "week", offset: 0 } },
  { id: "nextWeekStart", value: { unit: "week", offset: 1 } },
  { id: "monthStart", value: { unit: "month", offset: 0 } },
  { id: "nextMonthStart", value: { unit: "month", offset: 1 } },
];

export function relativeDateId(value: PlanRelativeDate): string {
  const preset = RELATIVE_DATE_PRESETS.find(
    (item) => item.value.unit === value.unit && item.value.offset === value.offset,
  );
  return preset?.id ?? "today";
}

export function relativeDateLabel(id: string, message: MessageFunction): string {
  return message(`query.relative.${id}` as
    | "query.relative.today"
    | "query.relative.tomorrow"
    | "query.relative.yesterday"
    | "query.relative.in7"
    | "query.relative.ago7"
    | "query.relative.in30"
    | "query.relative.weekStart"
    | "query.relative.nextWeekStart"
    | "query.relative.monthStart"
    | "query.relative.nextMonthStart");
}
