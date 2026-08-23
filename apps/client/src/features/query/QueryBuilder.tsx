// The query builder.
//
// It reads as a sentence — *Find blocks where all of …* — because that is the
// shape of the question a person actually has. Every row is the product's one
// dropdown (`ui/menu-select`), so a choice here behaves like a choice anywhere
// else, and nesting a group is what gives it the reach of the SPARQL it compiles
// to: any depth of AND / OR / NOT over any field the graph projects.
//
// **The sentence asks; it does not lay out.** What an answer shows and which way
// it is ordered are the reader's, changed while reading and belonging to the
// renderer they are read in — so they live on the answer
// (`QueryColumnsControl`, `QuerySortControl`) and not in the question. A builder
// that also held a `Show` row and a `Sort by` row was stating both twice, in a
// place the reader has to open the editor to reach.
//
// The builder is a pure editor over a plan value. It never runs, saves, or
// compiles anything; `QueryPanel` owns all of that.

import { useMemo, useState } from "react";
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { Input } from "@/ui/shadcn/input";
import { MenuSelect, type MenuSelectOption } from "@/ui/menu-select";
import { cn } from "@/lib/utils";
import type { GraphSnapshot } from "../../core-port/snapshot";
import { stringChoicesOf } from "../../entities/properties";
import { offeredChoices } from "../../entities/tasks";
import {
  appendNode,
  columnKindsFor,
  defaultValueForField,
  emptyGroup,
  fieldKindsFor,
  fieldType,
  graphPropertyKeys,
  queryFieldId,
  queryFieldsFor,
  newCondition,
  operatorsFor,
  operatorTakesList,
  operatorTakesRange,
  operatorTakesValue,
  PLAN_ANY_OF_MAX,
  PLAN_LIMIT_MAX,
  PLAN_MAX_CONDITIONS,
  PLAN_MAX_DEPTH,
  PLAN_SUBJECTS,
  replaceNode,
  countConditions,
  groupDepth,
  type PlanColumnSource,
  type PlanCondition,
  type PlanField,
  type PlanGroup,
  type PlanNode,
  type PlanSubject,
  type PlanValue,
  type QueryPlan,
} from "../../entities/query-plan";
import { todayLocalDate } from "../../entities/journal";
import { useI18n } from "../../i18n";
import { PageAutocomplete } from "../properties/PageAutocomplete";
import {
  choiceLabel,
  fieldLabel,
  matchLabel,
  operatorLabel,
  RELATIVE_DATE_PRESETS,
  relativeDateId,
  relativeDateLabel,
  subjectLabel,
} from "./labels";

const FIELD_PROPERTY_PREFIX = "property:";
const EXACT_DATE = "exact";

/**
 * A field in the builder is a word until someone reaches for it. `Input`'s own
 * ring and ground are Tailwind utilities, and the `utilities` layer outranks the
 * one `app.css` writes in — so a ghost field is stated here, at the call site,
 * where `tailwind-merge` can resolve it, rather than in a stylesheet that could
 * never win. Its focus state is the base field's already: `--surface-2` plus the
 * resting `--e1` edge.
 */
const GHOST_FIELD =
  "bg-transparent shadow-none hover:bg-[var(--surface-2)] hover:shadow-none";

export function QueryBuilder({
  id,
  plan,
  snapshot,
  readonly,
  onChange,
}: {
  /** The region the control that opened this editor answers for. */
  id?: string;
  plan: QueryPlan;
  snapshot: GraphSnapshot;
  readonly: boolean;
  onChange: (plan: QueryPlan) => void;
}) {
  const { message } = useI18n();
  const propertyKeys = useMemo(() => graphPropertyKeys(snapshot), [snapshot]);

  const setWhere = (where: PlanGroup) => onChange({ ...plan, where });

  return (
    <div className="query-builder" id={id} data-testid="query-builder">
      {/* One clause, one line. *Find blocks — all of the following.* The subject
          and the root group's match used to take a row each, which put two lead
          words and a line break inside a single sentence; the root group's head
          is this line, and only a nested group draws its own. */}
      <span className="qb-lead">{message("query.find")}</span>
      <div className="qb-line qb-head">
        <MenuSelect
          value={plan.subject}
          label={message("query.subjectLabel")}
          testId="qb-subject"
          disabled={readonly}
          options={PLAN_SUBJECTS.map((subject) => ({
            value: subject,
            label: subjectLabel(subject, message),
          }))}
          onValueChange={(value) => onChange(retarget(plan, value as PlanSubject))}
        />
        <MenuSelect
          value={plan.where.match}
          label={message("query.matchLabel")}
          testId="qb-match"
          disabled={readonly}
          options={(["all", "any", "none"] as const).map((match) => ({
            value: match,
            label: matchLabel(match, message),
          }))}
          onValueChange={(value) =>
            setWhere({ ...plan.where, match: value as PlanGroup["match"] })}
        />
        <span className="qb-lead">{message("query.ofTheFollowing")}</span>
      </div>

      {/* Column 2, with no lead of its own: the tree is the `Find` clause going
          on, not a new one. */}
      <GroupEditor
        group={plan.where}
        plan={plan}
        depth={0}
        propertyKeys={propertyKeys}
        snapshot={snapshot}
        readonly={readonly}
        onChange={setWhere}
        onRemove={null}
      />

      {/* The last of the sentence, and a clause like the two above it. Its lead
          word takes the lead column, so `Limit` starts at the same left edge as
          `Find` and its field at the same edge as the subject beside it — one
          left edge for every word in the builder, and one for every control.
          Held at the far end of the line instead, behind a seam, the two knobs
          most queries never touch read as two controls that had come loose from
          the sentence they belong to, and answered to no word at all. */}
      <span className="qb-lead">{message("query.limit")}</span>
      <div className="qb-line qb-tail">
        <Input
          // `px-2`, not the field's own 10px: it is the first control on its
          // line, so its text shares the left edge of every other clause's
          // first control exactly rather than nearly (§ Geometry).
          className={cn(GHOST_FIELD, "w-16 px-2")}
          type="number"
          min={1}
          max={PLAN_LIMIT_MAX}
          value={plan.limit}
          readOnly={readonly}
          aria-label={message("query.limit")}
          data-testid="qb-limit"
          onChange={(event) => {
            const next = Number(event.target.value);
            if (!Number.isFinite(next)) return;
            onChange({ ...plan, limit: Math.min(PLAN_LIMIT_MAX, Math.max(1, Math.round(next))) });
          }}
        />
        <label className="qb-check">
          <input
            type="checkbox"
            checked={plan.distinct}
            disabled={readonly}
            onChange={(event) => onChange({ ...plan, distinct: event.target.checked })}
          />
          {message("query.uniqueRows")}
        </label>
      </div>
    </div>
  );
}

/** Changing what a query looks for drops the fields the new subject cannot ask. */
function retarget(plan: QueryPlan, subject: PlanSubject): QueryPlan {
  if (subject === plan.subject) return plan;
  const fields = new Set(fieldKindsFor(subject));
  const sources = new Set(columnKindsFor(subject));
  const prune = (node: PlanNode): PlanNode | null => {
    if (node.kind === "condition") return fields.has(node.field.kind) ? node : null;
    const children = node.children.map(prune).filter((child): child is PlanNode => child !== null);
    return { ...node, children };
  };
  const columns = plan.columns.filter((column) => sources.has(column.source.kind));
  return {
    ...plan,
    subject,
    where: prune(plan.where) as PlanGroup,
    columns: columns.length > 0
      ? columns
      : [{ id: "text", source: { kind: "content" } as PlanColumnSource }],
  };
}

function GroupEditor({
  group,
  plan,
  depth,
  propertyKeys,
  snapshot,
  readonly,
  onChange,
  onRemove,
}: {
  group: PlanGroup;
  plan: QueryPlan;
  depth: number;
  propertyKeys: string[];
  snapshot: GraphSnapshot;
  readonly: boolean;
  onChange: (group: PlanGroup) => void;
  onRemove: (() => void) | null;
}) {
  const { message } = useI18n();
  const full = countConditions(plan.where) >= PLAN_MAX_CONDITIONS;
  const deep = groupDepth(plan.where) >= PLAN_MAX_DEPTH;

  const replaceChild = (id: string, next: PlanNode | null) =>
    onChange(replaceNode(group, id, next));

  return (
    <div className="qb-group" data-depth={depth} data-testid="qb-group">
      {/* The root group's head is the builder's first line, so it draws none of
          its own; a nested one is a clause inside a clause and says so. */}
      {depth > 0 && (
        <div className="qb-line qb-group-head">
          <MenuSelect
            value={group.match}
            label={message("query.matchLabel")}
            disabled={readonly}
            options={(["all", "any", "none"] as const).map((match) => ({
              value: match,
              label: matchLabel(match, message),
            }))}
            onValueChange={(value) =>
              onChange({ ...group, match: value as PlanGroup["match"] })}
          />
          <span className="qb-lead">{message("query.ofTheFollowing")}</span>
          {onRemove && (
            <button
              type="button"
              className="icon-btn qb-remove"
              disabled={readonly}
              aria-label={message("query.removeGroup")}
              onClick={onRemove}
            >
              <Trash2Icon aria-hidden />
            </button>
          )}
        </div>
      )}

      <div className="qb-children">
        {group.children.map((child) =>
          child.kind === "group" ? (
            <GroupEditor
              key={child.id}
              group={child}
              plan={plan}
              depth={depth + 1}
              propertyKeys={propertyKeys}
              snapshot={snapshot}
              readonly={readonly}
              onChange={(next) => replaceChild(child.id, next)}
              onRemove={() => replaceChild(child.id, null)}
            />
          ) : (
            <ConditionEditor
              key={child.id}
              condition={child}
              subject={plan.subject}
              propertyKeys={propertyKeys}
              snapshot={snapshot}
              readonly={readonly}
              onChange={(next) => replaceChild(child.id, next)}
              onRemove={() => replaceChild(child.id, null)}
            />
          ))}
        <div className="qb-line qb-add">
          <button
            type="button"
            className="qb-add-btn"
            disabled={readonly || full}
            data-testid={depth === 0 ? "qb-add-condition" : undefined}
            onClick={() =>
              onChange(appendNode(group, group.id, newCondition()))}
          >
            <PlusIcon aria-hidden />
            {message("query.addCondition")}
          </button>
          <button
            type="button"
            className="qb-add-btn"
            disabled={readonly || full || deep}
            data-testid={depth === 0 ? "qb-add-group" : undefined}
            onClick={() => onChange(appendNode(group, group.id, emptyGroup("any")))}
          >
            <PlusIcon aria-hidden />
            {message("query.addGroup")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ConditionEditor({
  condition,
  subject,
  propertyKeys,
  snapshot,
  readonly,
  onChange,
  onRemove,
}: {
  condition: PlanCondition;
  subject: PlanSubject;
  propertyKeys: string[];
  snapshot: GraphSnapshot;
  readonly: boolean;
  onChange: (condition: PlanCondition) => void;
  onRemove: () => void;
}) {
  const { message } = useI18n();
  const operators = operatorsFor(condition.field);

  const fieldOptions: MenuSelectOption[] = queryFieldsFor(subject, propertyKeys).map((field) => ({
    value: queryFieldId(field),
    label: fieldLabel(field, subject, message),
  }));

  const changeField = (encoded: string) => {
    const field: PlanField = encoded.startsWith(FIELD_PROPERTY_PREFIX)
      ? { kind: "property", key: encoded.slice(FIELD_PROPERTY_PREFIX.length) }
      : ({ kind: encoded } as PlanField);
    const next = operatorsFor(field);
    const op = next.includes(condition.op) ? condition.op : next[0];
    onChange({
      ...condition,
      field,
      op,
      value: operatorTakesValue(op) ? defaultValueForField(field) : undefined,
      value2: undefined,
    });
  };

  return (
    <div className="qb-condition" data-testid="qb-condition">
      <MenuSelect
        className="qb-field"
        value={condition.field.kind === "property"
          ? `${FIELD_PROPERTY_PREFIX}${condition.field.key}`
          : condition.field.kind}
        label={message("query.fieldLabel")}
        testId="qb-field"
        disabled={readonly}
        options={fieldOptions}
        onValueChange={changeField}
      />
      <MenuSelect
        className="qb-operator"
        value={condition.op}
        label={message("query.operatorLabel")}
        testId="qb-operator"
        disabled={readonly}
        options={operators.map((op) => ({ value: op, label: operatorLabel(op, message) }))}
        onValueChange={(value) => {
          const op = value as PlanCondition["op"];
          onChange({
            ...condition,
            op,
            value: operatorTakesValue(op)
              ? condition.value ?? defaultValueForField(condition.field)
              : undefined,
            value2: operatorTakesRange(op) ? condition.value2 : undefined,
          });
        }}
      />
      {operatorTakesValue(condition.op) && (
        <ValueEditor
          condition={condition}
          snapshot={snapshot}
          readonly={readonly}
          onChange={onChange}
        />
      )}
      <button
        type="button"
        className="icon-btn qb-remove"
        disabled={readonly}
        aria-label={message("query.removeCondition", {
          field: fieldLabel(condition.field, subject, message),
        })}
        onClick={onRemove}
      >
        <XIcon aria-hidden />
      </button>
    </div>
  );
}

function ValueEditor({
  condition,
  snapshot,
  readonly,
  onChange,
}: {
  condition: PlanCondition;
  snapshot: GraphSnapshot;
  readonly: boolean;
  onChange: (condition: PlanCondition) => void;
}) {
  const { message } = useI18n();
  if (operatorTakesList(condition.op)) {
    return (
      <ValueListEditor
        condition={condition}
        snapshot={snapshot}
        readonly={readonly}
        onChange={onChange}
      />
    );
  }
  const operand = (
    <Operand
      field={condition.field}
      value={condition.value ?? defaultValueForField(condition.field)}
      snapshot={snapshot}
      readonly={readonly}
      onChange={(value) => onChange({ ...condition, value })}
    />
  );
  if (!operatorTakesRange(condition.op)) return operand;
  return (
    <>
      {operand}
      <span className="qb-lead">{message("query.and")}</span>
      <Operand
        field={condition.field}
        value={condition.value2 ?? defaultValueForField(condition.field)}
        snapshot={snapshot}
        readonly={readonly}
        onChange={(value) => onChange({ ...condition, value2: value })}
      />
    </>
  );
}

/** One typed operand: the editor the field's own kind of value deserves. */
function Operand({
  field,
  value,
  snapshot,
  readonly,
  onChange,
}: {
  field: PlanField;
  value: PlanValue;
  snapshot: GraphSnapshot;
  readonly: boolean;
  onChange: (value: PlanValue) => void;
}) {
  const { message } = useI18n();
  const type = fieldType(field);

  if (type === "date") {
    const relative = value.type === "relative" ? relativeDateId(value.value) : EXACT_DATE;
    return (
      <span className="qb-operand">
        <MenuSelect
          value={relative}
          label={message("query.dateLabel")}
          testId="qb-date"
          disabled={readonly}
          options={[
            ...RELATIVE_DATE_PRESETS.map((preset) => ({
              value: preset.id,
              label: relativeDateLabel(preset.id, message),
            })),
            { value: EXACT_DATE, label: message("query.relative.exact") },
          ]}
          onValueChange={(next) => {
            if (next === EXACT_DATE) {
              onChange({ type: "date", value: value.type === "date" ? value.value : todayLocalDate() });
              return;
            }
            const preset = RELATIVE_DATE_PRESETS.find((item) => item.id === next);
            if (preset) onChange({ type: "relative", value: preset.value });
          }}
        />
        {value.type === "date" && (
          <Input
            type="date"
            className={cn(GHOST_FIELD, "w-36")}
            value={value.value}
            readOnly={readonly}
            aria-label={message("query.exactDate")}
            onChange={(event) => {
              if (event.target.value) onChange({ type: "date", value: event.target.value });
            }}
          />
        )}
      </span>
    );
  }

  if (type === "number" || type === "integer") {
    return (
      <Input
        className={cn(GHOST_FIELD, "w-20")}
        type="number"
        value={value.type === "number" ? value.value : 0}
        readOnly={readonly}
        aria-label={message("query.valueLabel")}
        data-testid="qb-value"
        onChange={(event) => onChange({ type: "number", value: Number(event.target.value) })}
      />
    );
  }

  if (type === "tag") {
    const tags = snapshot.tags;
    return (
      <MenuSelect
        className="qb-value"
        value={value.type === "tag" ? value.value : ""}
        label={message("query.valueLabel")}
        placeholder={message("query.pickTag")}
        testId="qb-value"
        disabled={readonly}
        options={tags.map((tag) => ({ value: tag.id, label: tag.name }))}
        onValueChange={(next) => onChange({ type: "tag", value: next })}
      />
    );
  }

  if (type === "page") {
    const current = value.type === "page" ? value.value : "";
    const page = snapshot.pages.find((item) => item.id === current);
    return (
      <span className="qb-operand">
        {page && <span className="qb-chip">{page.title || page.id}</span>}
        {!readonly && (
          <PageAutocomplete
            placeholder={message("query.pickPage")}
            onPick={(id) => onChange({ type: "page", value: id })}
          />
        )}
      </span>
    );
  }

  const choices = field.kind === "property"
    ? offeredChoices(field.key, stringChoicesOf(field.key))
    : [];
  if (choices.length > 0) {
    const current = value.type === "text" ? value.value : "";
    const options = current && !choices.includes(current) ? [current, ...choices] : choices;
    return (
      <MenuSelect
        className="qb-value"
        value={current}
        label={message("query.valueLabel")}
        placeholder={message("query.pickValue")}
        testId="qb-value"
        disabled={readonly}
        options={options.map((choice) => ({
          value: choice,
          label: field.kind === "property" ? choiceLabel(field.key, choice, message) : choice,
        }))}
        onValueChange={(next) => onChange({ type: "text", value: next })}
      />
    );
  }

  return (
    <Input
      className={cn(GHOST_FIELD, "w-56 max-w-full")}
      value={value.type === "text" ? value.value : ""}
      readOnly={readonly}
      placeholder={message("query.valuePlaceholder")}
      aria-label={message("query.valueLabel")}
      data-testid="qb-value"
      onChange={(event) => onChange({ type: "text", value: event.target.value })}
    />
  );
}

/** `is any of` — a set of alternatives, held as removable chips. */
function ValueListEditor({
  condition,
  snapshot,
  readonly,
  onChange,
}: {
  condition: PlanCondition;
  snapshot: GraphSnapshot;
  readonly: boolean;
  onChange: (condition: PlanCondition) => void;
}) {
  const { message } = useI18n();
  const [draft, setDraft] = useState("");
  const members = condition.value?.type === "list" ? condition.value.values : [];
  const type = fieldType(condition.field);
  const choices = condition.field.kind === "property"
    ? offeredChoices(condition.field.key, stringChoicesOf(condition.field.key))
    : [];

  const setMembers = (next: string[]) =>
    onChange({ ...condition, value: { type: "list", values: next.slice(0, PLAN_ANY_OF_MAX) } });

  const add = (member: string) => {
    const trimmed = member.trim();
    if (!trimmed || members.includes(trimmed)) return;
    setMembers([...members, trimmed]);
  };

  const nameOf = (member: string): string => {
    if (type === "tag") return snapshot.tags.find((tag) => tag.id === member)?.name ?? member;
    if (type === "page") {
      const page = snapshot.pages.find((item) => item.id === member);
      return page ? page.title || page.id : member;
    }
    return member;
  };

  const remaining = type === "tag"
    ? snapshot.tags.filter((tag) => !members.includes(tag.id))
      .map((tag) => ({ value: tag.id, label: tag.name }))
    : choices.filter((choice) => !members.includes(choice))
      .map((choice) => ({ value: choice, label: choice }));

  return (
    <span className="qb-operand qb-list" data-testid="qb-value-list">
      {members.map((member) => (
        <span key={member} className="qb-chip">
          {nameOf(member)}
          <button
            type="button"
            aria-label={message("query.removeValue", { value: nameOf(member) })}
            disabled={readonly}
            onClick={() => setMembers(members.filter((item) => item !== member))}
          >
            <XIcon aria-hidden />
          </button>
        </span>
      ))}
      {members.length >= PLAN_ANY_OF_MAX ? null : type === "page" ? (
        !readonly && (
          <PageAutocomplete placeholder={message("query.pickPage")} onPick={(id) => add(id)} />
        )
      ) : remaining.length > 0 ? (
        <MenuSelect
          className="qb-value"
          value=""
          label={message("query.addValue")}
          placeholder={message("query.addValue")}
          disabled={readonly}
          options={remaining}
          onValueChange={add}
        />
      ) : (
        <Input
          className={cn(GHOST_FIELD, "w-56 max-w-full")}
          value={draft}
          readOnly={readonly}
          placeholder={message("query.addValue")}
          aria-label={message("query.addValue")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            event.preventDefault();
            add(draft);
            setDraft("");
          }}
          onBlur={() => {
            add(draft);
            setDraft("");
          }}
        />
      )}
    </span>
  );
}
