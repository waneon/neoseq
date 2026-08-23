// A plan, written out as the SPARQL the core actually runs.
//
// Two rules keep this honest. Every user value leaves as a *parameter* — a
// bound variable, never text spliced into the source — so a plan cannot inject
// syntax and a relative date ("due today") resolves fresh on every run instead
// of being frozen into the stored query. And the emitted source stays readable:
// it is what a person sees when they open the SPARQL panel, and the thing they
// keep when they eject from the builder.

import type { RdfTerm } from "../generated/core-port";
import { addDays } from "./journal";
import { orderSemanticsForColumn } from "./query-ordering";
import { valueTypeOf } from "./properties";
import {
  columnVariable,
  fieldType,
  PLAN_ANY_OF_MAX,
  PLAN_LIMIT_MAX,
  type PlanColumn,
  type PlanCondition,
  type PlanField,
  type PlanGroup,
  type PlanNode,
  type PlanOperator,
  type PlanRelativeDate,
  type PlanScalar,
  type PlanSubject,
  type PlanValue,
  type QueryPlan,
} from "./query-plan";

const NEO = "urn:neoseq:vocab:v1:";
const PROPERTY = "urn:neoseq:property:";
const ENTITY = "urn:neoseq:entity:";
const XSD = "http://www.w3.org/2001/XMLSchema#";

/** What a list column joins its members with, and what the renderer splits on. */
/**
 * The query profile the core reads, and the only one it accepts. It travels with
 * every request and is stored in every query document, so it is named once here
 * rather than restated by each surface that asks a question.
 */
export const QUERY_LANGUAGE = "sparql-1.1/neoseq-v1" as const;

export const LIST_SEPARATOR = "\u001F";

export interface PlanParameter {
  name: string;
  value: PlanScalar;
}

export interface CompiledPlan {
  source: string;
  parameters: PlanParameter[];
  /** Result variables in projection order, so a view can lay out before a run. */
  variables: string[];
  /**
   * The variable carrying which thing each row *is*. It is selected even when no
   * column asked for it, because a row has to be openable; a summary has no such
   * variable, because there the row is the group.
   */
  subjectVariable: string | null;
}

export interface PlanRuntime {
  graphId: string;
  today: string;
}

const SUBJECT_TYPE: Record<PlanSubject, string> = {
  block: "neo:Block",
  page: "neo:Page",
  tag: "neo:Tag",
};

function contentPredicate(subject: PlanSubject): string {
  return subject === "tag" ? "neo:name" : "neo:content";
}

/** The same percent-encoding the RDF projection uses for IRI components. */
export function encodeComponent(value: string): string {
  let encoded = "";
  for (const byte of new TextEncoder().encode(value)) {
    const character = String.fromCharCode(byte);
    if (/[A-Za-z0-9\-._~]/.test(character)) encoded += character;
    else encoded += `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

export function entityIri(graphId: string, kind: "page" | "block" | "tag", id: string): string {
  return `${ENTITY}${encodeComponent(graphId)}:${kind}:${encodeComponent(id)}`;
}

export function resolveRelativeDate(relative: PlanRelativeDate, today: string): string {
  if (relative.unit === "day") return addDays(today, relative.offset);
  if (relative.unit === "week") {
    const [year, month, day] = today.split("-").map(Number);
    // Monday starts the week; `getUTCDay` counts Sunday as 0.
    const weekday = (new Date(Date.UTC(year, month - 1, day)).getUTCDay() + 6) % 7;
    return addDays(today, -weekday + relative.offset * 7);
  }
  const [year, month] = today.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1 + relative.offset, 1));
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-01`;
}

/** One scalar plan value as the RDF term the core binds it to. */
export function planTerm(value: PlanScalar, runtime: PlanRuntime): RdfTerm {
  switch (value.type) {
    case "number":
      return { kind: "literal", value: String(value.value), datatype: `${XSD}double` };
    case "date":
      return { kind: "literal", value: value.value, datatype: `${XSD}date` };
    case "relative":
      return {
        kind: "literal",
        value: resolveRelativeDate(value.value, runtime.today),
        datatype: `${XSD}date`,
      };
    case "page":
      return { kind: "iri", value: entityIri(runtime.graphId, "page", value.value) };
    case "tag":
      return { kind: "iri", value: entityIri(runtime.graphId, "tag", value.value) };
    default:
      return { kind: "literal", value: value.value, datatype: `${XSD}string` };
  }
}

export function planBindings(
  parameters: PlanParameter[],
  runtime: PlanRuntime,
): Record<string, RdfTerm> {
  const bindings: Record<string, RdfTerm> = {};
  for (const parameter of parameters) bindings[parameter.name] = planTerm(parameter.value, runtime);
  return bindings;
}

// ── Compilation ───────────────────────────────────────────────────────────────

/**
 * Carries everything the pattern writers need: which kind of thing the query is
 * about, what its variable is called, and how a user value reaches the engine.
 */
class Emitter {
  parameters: PlanParameter[] = [];
  private counter = 0;

  constructor(
    readonly subject: PlanSubject,
    readonly self: string,
    /** Set when the source must stand alone — the eject-to-SPARQL path. */
    private readonly runtime: PlanRuntime | null,
  ) {}

  /** A user value becomes a bound variable, or a literal when standing alone. */
  operand(value: PlanScalar): string {
    if (this.runtime) return literal(value, this.runtime);
    const name = `q_p${this.parameters.length}`;
    this.parameters.push({ name, value });
    return `?${name}`;
  }

  local(prefix: string): string {
    this.counter += 1;
    return `q_${prefix}${this.counter}`;
  }
}

function literal(value: PlanScalar, runtime: PlanRuntime): string {
  const term = planTerm(value, runtime);
  if (term.kind === "iri") return `<${term.value}>`;
  if (term.datatype === `${XSD}string`) return quote(term.value);
  if (term.datatype === `${XSD}double`) return term.value;
  return `${quote(term.value)}^^<${term.datatype}>`;
}

function quote(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")}"`;
}

function propertyPredicate(key: string): string {
  return `prop:${encodeComponent(key)}`;
}

function fieldPredicate(field: PlanField, subject: PlanSubject): string {
  switch (field.kind) {
    case "content":
      return contentPredicate(subject);
    case "property":
      return propertyPredicate(field.key);
    case "tag":
      return "neo:tag";
    case "page":
      return "neo:page";
    case "ancestor":
      return "neo:parent+";
    case "sibling_index":
      return "neo:siblingIndex";
  }
}

/**
 * `equals` reads best as a constant in the triple pattern, but only where the
 * stored term is written the same way. Numbers are projected as `xsd:double`
 * and sibling indexes as `xsd:integer`, so those compare by value in a FILTER
 * instead of matching by term.
 */
function equalsByTerm(field: PlanField): boolean {
  const type = fieldType(field);
  return type !== "number" && type !== "integer";
}

const NEGATED: Partial<Record<PlanOperator, PlanOperator>> = {
  not_contains: "contains",
  not_equals: "equals",
  is_empty: "is_set",
};

function conditionBody(condition: PlanCondition, emitter: Emitter, indent: string): string[] {
  const predicate = fieldPredicate(condition.field, emitter.subject);
  const lines: string[] = [];
  const op = condition.op;
  const value = condition.value;

  if (op === "is_true" || op === "is_false") {
    return [`${indent}${emitter.self} ${predicate} ${op === "is_true"} .`];
  }
  if (op === "is_set") {
    return [`${indent}${emitter.self} ${predicate} ?${emitter.local("v")} .`];
  }
  if (!value) return lines;

  // `is any of` is the one operator whose operand is a set; every other one
  // takes a single value, so the rest of this reads one scalar.
  if (op === "any_of") {
    const members = listMembers(value)
      .slice(0, PLAN_ANY_OF_MAX)
      .map((member) => emitter.operand(memberValue(condition.field, member)));
    if (members.length === 0) return [];
    const bound = `?${emitter.local("v")}`;
    return [
      `${indent}${emitter.self} ${predicate} ${bound} .`,
      `${indent}FILTER(${bound} IN (${members.join(", ")}))`,
    ];
  }
  if (value.type === "list") return [];

  if (op === "equals" && equalsByTerm(condition.field)) {
    return [`${indent}${emitter.self} ${predicate} ${emitter.operand(value)} .`];
  }

  const self = `?${emitter.local("v")}`;
  lines.push(`${indent}${emitter.self} ${predicate} ${self} .`);

  if (op === "equals") {
    lines.push(`${indent}FILTER(${self} = ${emitter.operand(value)})`);
  } else if (op === "contains") {
    // Markdown search goes through the profile's own text function, which knows
    // the analyzer; anything else is a substring test on the lexical form.
    const operand = emitter.operand(value);
    lines.push(condition.field.kind === "content"
      ? `${indent}FILTER(neo:matchesText(${self}, ${operand}))`
      : `${indent}FILTER(CONTAINS(LCASE(STR(${self})), LCASE(${operand})))`);
  } else if (op === "starts_with") {
    lines.push(`${indent}FILTER(STRSTARTS(LCASE(STR(${self})), LCASE(${emitter.operand(value)})))`);
  } else if (op === "ends_with") {
    lines.push(`${indent}FILTER(STRENDS(LCASE(STR(${self})), LCASE(${emitter.operand(value)})))`);
  } else if (op === "between") {
    const upperValue = condition.value2;
    const lower = emitter.operand(value);
    const upper = emitter.operand(
      upperValue && upperValue.type !== "list" ? upperValue : value,
    );
    lines.push(`${indent}FILTER(${self} >= ${lower} && ${self} <= ${upper})`);
  } else {
    const comparison = { lt: "<", lte: "<=", gt: ">", gte: ">=" }[op as "lt" | "lte" | "gt" | "gte"];
    lines.push(`${indent}FILTER(${self} ${comparison} ${emitter.operand(value)})`);
  }
  return lines;
}

function listMembers(value: PlanValue): string[] {
  if (value.type === "list") return value.values.filter((member) => member.length > 0);
  if (value.type === "text") return value.value ? [value.value] : [];
  return [];
}

function memberValue(field: PlanField, member: string): PlanScalar {
  const type = fieldType(field);
  if (type === "page") return { type: "page", value: member };
  if (type === "tag") return { type: "tag", value: member };
  return { type: "text", value: member };
}

/**
 * One node's contribution to the WHERE clause. A negative operator asks whether
 * its positive twin has *no* answer, so “does not contain” keeps the rows that
 * carry no such value at all rather than dropping them.
 */
function nodeBody(node: PlanNode, emitter: Emitter, indent: string): string[] {
  if (node.kind === "group") return groupBody(node, emitter, indent);
  const positive = NEGATED[node.op];
  if (!positive) return conditionBody(node, emitter, indent);
  const body = conditionBody({ ...node, op: positive }, emitter, `${indent}  `);
  if (body.length === 0) return [];
  return [`${indent}FILTER NOT EXISTS {`, ...body, `${indent}}`];
}

/**
 * Alternatives compile to a disjunction of `EXISTS`, not to `UNION`.
 *
 * A `UNION` branch is evaluated on its own and only then joined, so neither the
 * subject nor any bound parameter is visible inside it — a branch would ask its
 * question of the whole graph, and a parameter would be unbound. `EXISTS` is
 * evaluated against the solution in hand, which is exactly the reading “any of
 * these is true *of this row*”.
 */
function groupBody(group: PlanGroup, emitter: Emitter, indent: string): string[] {
  if (group.match === "all") {
    return group.children.flatMap((child) => nodeBody(child, emitter, indent));
  }
  const branches = group.children
    .map((child) => nodeBody(child, emitter, `${indent}    `))
    .filter((body) => body.length > 0)
    .map((body) => [`${indent}  EXISTS {`, ...body, `${indent}  }`].join("\n"));
  if (branches.length === 0) return [];
  const disjunction = branches.join(`\n${indent}  || `);
  const test = group.match === "any" ? disjunction : `!(\n${disjunction}\n${indent}  )`;
  return [`${indent}FILTER(`, ...test.split("\n"), `${indent})`];
}

function columnPattern(column: PlanColumn, emitter: Emitter, target: string): string[] {
  const source = column.source;
  if (source.kind === "subject") return [];
  if (source.kind === "tags") {
    const tag = `?${emitter.local("t")}`;
    return [`  OPTIONAL { ${emitter.self} neo:tag ${tag} . ${tag} neo:name ?${target} }`];
  }
  if (source.kind === "property") {
    const predicate = propertyPredicate(source.key);
    // A reference folded into one cell reads as page names, not as IRIs.
    if (valueTypeOf(source.key) === "page" && column.aggregate === "list") {
      const reference = `?${emitter.local("r")}`;
      return [
        `  OPTIONAL { ${emitter.self} ${predicate} ${reference} .`,
        `             OPTIONAL { ${reference} neo:content ?${target} } }`,
      ];
    }
    return [`  OPTIONAL { ${emitter.self} ${predicate} ?${target} }`];
  }
  const predicate = {
    content: contentPredicate(emitter.subject),
    page: "neo:page",
    parent: "neo:parent",
    sibling_index: "neo:siblingIndex",
  }[source.kind];
  return [`  OPTIONAL { ${emitter.self} ${predicate} ?${target} }`];
}

function aggregateExpression(column: PlanColumn, inner: string): string {
  switch (column.aggregate) {
    case "count":
      return `COUNT(DISTINCT ${inner})`;
    case "sum":
      return `SUM(${inner})`;
    case "avg":
      return `AVG(${inner})`;
    case "min":
      return `MIN(${inner})`;
    case "max":
      return `MAX(${inner})`;
    default:
      return `GROUP_CONCAT(DISTINCT ${inner}; SEPARATOR="\\u001F")`;
  }
}

function directed(expression: string, direction: "asc" | "desc"): string {
  return `${direction.toUpperCase()}(${expression})`;
}

function boundLast(variable: string): string {
  return `ASC(IF(BOUND(?${variable}), 0, 1))`;
}

function textOrder(variable: string, direction: "asc" | "desc"): string[] {
  return [
    boundLast(variable),
    directed(`LCASE(STR(?${variable}))`, direction),
    directed(`STR(?${variable})`, direction),
  ];
}

/** The standard-SPARQL order expressions for one semantic column. */
function columnOrder(
  column: PlanColumn,
  variable: string,
  direction: "asc" | "desc",
  emitter: Emitter,
  where: string[],
): string[] {
  const semantics = orderSemanticsForColumn(column);
  if (semantics.kind === "unsupported_list") return [];

  if (semantics.kind === "ranked" && semantics.values.length > 0) {
    const known = semantics.values.map(quote).join(", ");
    let rank = "0";
    for (let index = semantics.values.length - 1; index >= 0; index -= 1) {
      rank = `IF(?${variable} = ${quote(semantics.values[index])}, ${index}, ${rank})`;
    }
    if (semantics.missing === "below") {
      return [
        // Priority absence is rank -1: before Low ascending and after Low
        // descending. Open-choice fallbacks remain outside the declared domain
        // and therefore last in either direction.
        `ASC(IF(!BOUND(?${variable}), 0, IF(?${variable} IN (${known}), 0, 1)))`,
        directed(`IF(BOUND(?${variable}), ${rank}, -1)`, direction),
        directed(`LCASE(STR(?${variable}))`, direction),
        directed(`STR(?${variable})`, direction),
      ];
    }
    return [
      // Known choices first, open-choice fallbacks next, and unbound last in
      // both directions. Only the value inside each bucket reverses.
      `ASC(IF(!BOUND(?${variable}), 2, IF(?${variable} IN (${known}), 0, 1)))`,
      directed(`IF(BOUND(?${variable}), ${rank}, 0)`, direction),
      directed(`LCASE(STR(?${variable}))`, direction),
      directed(`STR(?${variable})`, direction),
    ];
  }

  if (semantics.kind === "entity_label") {
    const label = emitter.local("o");
    where.push(`  OPTIONAL { ?${variable} neo:content ?${label} }`);
    const key = `COALESCE(STR(?${label}), STR(?${variable}))`;
    return [
      boundLast(variable),
      directed(`LCASE(${key})`, direction),
      directed(key, direction),
      directed(`STR(?${variable})`, direction),
    ];
  }

  if (semantics.kind === "text") return textOrder(variable, direction);
  return [boundLast(variable), directed(`?${variable}`, direction)];
}

/**
 * The variable the subject travels under. It is the compiler's own, never a
 * column's, so a result always identifies its rows the same way whatever the
 * plan happens to show.
 */
export const SUBJECT_VARIABLE = "q_subject";

function compile(plan: QueryPlan, runtime: PlanRuntime | null): CompiledPlan {
  const self = SUBJECT_VARIABLE;
  const emitter = new Emitter(plan.subject, `?${self}`, runtime);
  const where: string[] = [
    `  ?${self} a ${SUBJECT_TYPE[plan.subject]} .`,
    ...groupBody(plan.where, emitter, "  "),
  ];

  const projection: string[] = [];
  const grouped: string[] = [];
  const variables: string[] = [];
  let aggregated = false;

  for (const column of plan.columns) {
    const variable = columnVariable(column);
    if (column.aggregate) {
      aggregated = true;
      const inner = column.source.kind === "subject"
        ? `?${self}`
        : `?${emitter.local("a")}`;
      if (column.source.kind !== "subject") {
        where.push(...columnPattern(column, emitter, inner.slice(1)));
      }
      variables.push(variable);
      projection.push(`(${aggregateExpression(column, inner)} AS ?${variable})`);
      continue;
    }
    where.push(...columnPattern(column, emitter, variable));
    variables.push(variable);
    projection.push(`?${variable}`);
    grouped.push(`?${variable}`);
  }

  // Every row has to know which thing it is before it can be opened, so the
  // subject is selected whether or not a column asked for it. A summary
  // (anything aggregated) is the exception: there the row *is* the group.
  const carriesSubject = !aggregated;
  if (carriesSubject) {
    projection.unshift(`?${self}`);
    grouped.unshift(`?${self}`);
    variables.unshift(self);
  }

  const order = plan.sort.flatMap((entry) => {
    const column = plan.columns.find((item) => item.id === entry.column);
    if (!column) return [];
    return columnOrder(column, columnVariable(column), entry.direction, emitter, where);
  });
  // Unordered SPARQL results are a set; a stable presentation needs the subject
  // as its final tie-break (architectures/query.md § SPARQL Profile).
  if (carriesSubject) order.push(`?${self}`);

  const distinct = plan.distinct && !aggregated ? "DISTINCT " : "";
  const lines = [
    `PREFIX neo: <${NEO}>`,
    `PREFIX prop: <${PROPERTY}>`,
    `SELECT ${distinct}${projection.join(" ")} WHERE {`,
    ...where,
    "}",
  ];
  if (aggregated && grouped.length > 0) lines.push(`GROUP BY ${grouped.join(" ")}`);
  if (order.length > 0) lines.push(`ORDER BY ${order.join(" ")}`);
  lines.push(`LIMIT ${Math.min(PLAN_LIMIT_MAX, Math.max(1, Math.round(plan.limit)))}`);

  return {
    source: `${lines.join("\n")}\n`,
    parameters: emitter.parameters,
    variables,
    subjectVariable: carriesSubject ? self : null,
  };
}

/** The stored form: parameters stay unbound, so the source outlives today. */
export function compilePlan(plan: QueryPlan): CompiledPlan {
  return compile(plan, null);
}
