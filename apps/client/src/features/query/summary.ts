// The query, restated in one line.
//
// The plan read back as a phrase — `Blocks · Status is Done` — built from the same
// `labels` vocabulary the builder's own rows print, so what a reader is told the
// query asks is word-for-word what they find when they open it.
//
// It is not printed over the answer. A machine-written sentence stated
// permanently above every result is chrome that repeats the builder one hover
// away, and it is noise beside a question the reader has already named. So the
// phrase has two homes, both of them places somebody went looking for it: the
// name of the control that opens the question, and the name Settings offers a
// standing question that nobody has titled yet.
//
// It is a summary, not a transcript: two conditions per level, then a count of
// what is left. A nested group keeps its parentheses, because "or" inside "and"
// is the one thing a flattened list would misreport.

import type { GraphSnapshot } from "../../core-port/snapshot";
import { stringChoicesOf } from "../../entities/properties";
import { offeredChoices } from "../../entities/tasks";
import {
  fieldType,
  operatorTakesRange,
  operatorTakesValue,
  type PlanCondition,
  type PlanField,
  type PlanGroup,
  type PlanNode,
  type PlanValue,
  type QueryPlan,
} from "../../entities/query-plan";
import type { MessageFunction } from "../../i18n";
import {
  choiceLabel,
  fieldLabel,
  operatorLabel,
  relativeDateId,
  relativeDateLabel,
  subjectLabel,
} from "./labels";

/** Punctuation, not an icon: the same middot every grouped list in the product uses. */
const SEPARATOR = " · ";

/** How many conditions a level names before it starts counting them instead. */
const SHOWN_PER_LEVEL = 2;

/** How many members of an `is any of` list the phrase names. */
const SHOWN_MEMBERS = 2;

export interface QuerySummary {
  /** What the query looks for — `Blocks`, or `SPARQL` for a hand-written one. */
  lead: string;
  /** What narrows it, or `null` when nothing does. */
  detail: string | null;
}

export interface SummaryContext {
  snapshot: GraphSnapshot;
  message: MessageFunction;
  /** The reader's own journal format, so a date reads here as it reads in a cell. */
  formatDate: (date: string) => string;
}

export function planSummary(plan: QueryPlan, context: SummaryContext): QuerySummary {
  return {
    lead: subjectLabel(plan.subject, context.message),
    detail: describeGroup(plan.where, plan, context),
  };
}

/** The phrase as one string: `Blocks · Status is Doing`, halves and punctuation. */
export function summaryLabel(summary: QuerySummary): string {
  return summary.detail ? `${summary.lead}${SEPARATOR}${summary.detail}` : summary.lead;
}

/** A group's own reading: its children, joined the way its match combines them. */
function describeGroup(
  group: PlanGroup,
  plan: QueryPlan,
  context: SummaryContext,
): string | null {
  const parts = group.children
    .map((child) => describeNode(child, plan, context))
    .filter((part): part is string => part !== null);
  if (parts.length === 0) return null;

  const shown = parts.slice(0, SHOWN_PER_LEVEL);
  const rest = parts.length - shown.length;
  const joined = rest > 0
    ? [...shown, context.message("query.summaryMore", { count: rest })].join(SEPARATOR)
    : shown.join(SEPARATOR);

  // `all` is the reading a bare list already has, so it says nothing extra.
  if (group.match === "all") return joined;
  return context.message(
    group.match === "any" ? "query.summaryAny" : "query.summaryNone",
    { conditions: joined },
  );
}

function describeNode(
  node: PlanNode,
  plan: QueryPlan,
  context: SummaryContext,
): string | null {
  if (node.kind === "condition") return describeCondition(node, plan, context);
  const inner = describeGroup(node, plan, context);
  return inner === null ? null : `(${inner})`;
}

function describeCondition(
  condition: PlanCondition,
  plan: QueryPlan,
  context: SummaryContext,
): string {
  const { message } = context;
  const words = [
    fieldLabel(condition.field, plan.subject, message),
    operatorLabel(condition.op, message),
  ];
  if (operatorTakesValue(condition.op)) {
    words.push(valueText(condition.field, condition.value, context));
    if (operatorTakesRange(condition.op)) {
      words.push(message("query.and"), valueText(condition.field, condition.value2, context));
    }
  }
  return words.filter((word) => word.length > 0).join(" ");
}

/** One operand as a person wrote it: a name, a day, a choice — never a raw id. */
function valueText(
  field: PlanField,
  value: PlanValue | undefined,
  context: SummaryContext,
): string {
  if (!value) return "";
  switch (value.type) {
    case "text":
      return textOperand(field, value.value, context);
    case "number":
      return String(value.value);
    case "date":
      return context.formatDate(value.value);
    case "relative":
      return relativeDateLabel(relativeDateId(value.value), context.message);
    case "tag":
      return tagName(value.value, context);
    case "page":
      return pageName(value.value, context);
    case "list":
      return describeList(field, value.values, context);
  }
}

function describeList(field: PlanField, members: string[], context: SummaryContext): string {
  const shown = members
    .slice(0, SHOWN_MEMBERS)
    .map((member) => memberName(field, member, context));
  const rest = members.length - shown.length;
  if (rest > 0) shown.push(context.message("query.summaryMore", { count: rest }));
  return shown.join(", ");
}

/** A list member is a bare id, so its name comes from the field's own type. */
function memberName(field: PlanField, member: string, context: SummaryContext): string {
  const type = fieldType(field);
  if (type === "tag") return tagName(member, context);
  if (type === "page") return pageName(member, context);
  return textOperand(field, member, context);
}

/**
 * A string operand, told apart the way the builder's own `Operand` tells it
 * apart: a field that offers choices had one chosen, so it reads as that choice's
 * own name; a field that does not was typed into, so it is quoted. `contains the`
 * hides where the operand starts and `contains “the”` does not.
 */
function textOperand(field: PlanField, value: string, context: SummaryContext): string {
  if (value.length === 0) return "";
  const chosen = field.kind === "property"
    && offeredChoices(field.key, stringChoicesOf(field.key)).length > 0;
  return chosen
    ? choiceLabel(field.key, value, context.message)
    : context.message("query.summaryQuoted", { value });
}

/** A tag speaks its own `#` voice in a caption, as it does everywhere else. */
function tagName(id: string, context: SummaryContext): string {
  return `#${context.snapshot.tags.find((tag) => tag.id === id)?.name ?? id}`;
}

function pageName(id: string, context: SummaryContext): string {
  const page = context.snapshot.pages.find((item) => item.id === id);
  return page ? page.title || page.id : id;
}
