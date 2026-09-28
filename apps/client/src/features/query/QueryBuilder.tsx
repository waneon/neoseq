import { namedDocuments } from "../../entities/names";
import { useMemo, useState } from "react";
import { PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { Input } from "@/ui/shadcn/input";
import { Button } from "@/ui/shadcn/button";
import { MenuSelect, type MenuSelectOption } from "@/ui/menu-select";
import type { GraphSnapshot } from "../../core-port/snapshot";
import { stringChoicesOf } from "../../entities/properties";
import { offeredChoices } from "../../entities/tasks";
import {
  appendNode,
  columnKindsFor,
  columnSourceKey,
  columnSourcesFor,
  defaultPlan,
  defaultValueForField,
  emptyGroup,
  fieldKindsFor,
  fieldType,
  graphPropertyKeys,
  queryFieldId,
  queryFieldsFor,
  newCondition,
  nextColumnId,
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
  type PlanAggregate,
  type PlanColumn,
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
  aggregateLabel,
  columnSourceLabel,
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
      <div className="qb-target">
        <span className="qb-heading">{message("query.find")}</span>
        <MenuSelect
          className="qb-subject"
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
      </div>

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

      <div className="qb-settings">
        <div className="qb-setting">
          <span className="qb-label">{message("query.grain")}</span>
          <MenuSelect
            value={plan.grain}
            label={message("query.grain")}
            testId="qb-grain"
            disabled={readonly}
            options={[
              { value: "entity", label: message("query.grain.entity") },
              { value: "summary", label: message("query.grain.summary") },
            ]}
            onValueChange={(grain) =>
              onChange({
                ...plan,
                grain: grain as QueryPlan["grain"],
                columns:
                  grain === "summary"
                    ? [{ id: "count", source: { kind: "subject" }, aggregate: "count" }]
                    : defaultPlan(plan.subject).columns,
              })
            }
          />
        </div>
        <label className="qb-setting qb-limit">
          <span className="qb-label">{message("query.limit")}</span>
          <Input
            className="w-20"
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
        </label>
      </div>
      {plan.grain === "summary" && (
        <div className="qb-summary">
          <span className="qb-heading">{message("query.summaryFields")}</span>
          <SummaryColumns
            plan={plan}
            propertyKeys={propertyKeys}
            readonly={readonly}
            onChange={onChange}
          />
        </div>
      )}
    </div>
  );
}

function SummaryColumns({
  plan,
  propertyKeys,
  readonly,
  onChange,
}: {
  plan: QueryPlan;
  propertyKeys: string[];
  readonly: boolean;
  onChange: (plan: QueryPlan) => void;
}) {
  const { message } = useI18n();
  const sources: PlanColumnSource[] = [
    { kind: "subject" },
    ...columnSourcesFor(plan.subject, propertyKeys),
  ];
  const aggregates = plan.columns.filter((column) => column.aggregate !== undefined).length;
  const update = (id: string, patch: Partial<PlanColumn>) =>
    onChange({
      ...plan,
      columns: plan.columns.map((column) => (column.id === id ? { ...column, ...patch } : column)),
    });
  return (
    <div className="qb-summary-fields" data-testid="qb-summary-fields">
      {plan.columns.map((column) => (
        <div className="qb-summary-row" key={column.id}>
          <MenuSelect
            value={column.aggregate ?? "group"}
            label={message("query.summaryOperation")}
            disabled={readonly}
            options={[
              ...(column.aggregate && aggregates === 1
                ? []
                : [{ value: "group", label: message("query.groupBy") }]),
              ...(["count", "sum", "avg", "min", "max"] as const).map((aggregate) => ({
                value: aggregate,
                label: aggregateLabel(aggregate, message),
              })),
            ]}
            onValueChange={(value) =>
              update(column.id, {
                aggregate: value === "group" ? undefined : (value as PlanAggregate),
              })
            }
          />
          <MenuSelect
            value={columnSourceKey(column.source)}
            label={message("query.fieldLabel")}
            disabled={readonly}
            options={sources.map((source) => ({
              value: columnSourceKey(source),
              label: columnSourceLabel(source, plan.subject, message),
            }))}
            onValueChange={(value) => {
              const source = sources.find((source) => columnSourceKey(source) === value);
              if (source) update(column.id, { source });
            }}
          />
          <Button
            size="icon"
            className="qb-remove"
            disabled={readonly || Boolean(column.aggregate && aggregates === 1)}
            aria-label={message("query.removeSummaryField")}
            onClick={() =>
              onChange({ ...plan, columns: plan.columns.filter((item) => item.id !== column.id) })
            }
          >
            <XIcon aria-hidden />
          </Button>
        </div>
      ))}
      <Button
        variant="ghost"
        className="qb-add-btn"
        disabled={readonly}
        onClick={() =>
          onChange({
            ...plan,
            columns: [
              ...plan.columns,
              { id: nextColumnId(plan, "group"), source: { kind: "content" } },
            ],
          })
        }
      >
        <PlusIcon aria-hidden />
        {message("query.addSummaryField")}
      </Button>
    </div>
  );
}

/** Changing what a query looks for drops the fields the new subject cannot ask. */
function retarget(plan: QueryPlan, subject: PlanSubject): QueryPlan {
  if (subject === plan.subject) return plan;
  const fields = new Set(fieldKindsFor(subject));
  const sources = new Set<PlanColumnSource["kind"]>(["subject", ...columnKindsFor(subject)]);
  const prune = (node: PlanNode): PlanNode | null => {
    if (node.kind === "condition") return fields.has(node.field.kind) ? node : null;
    const children = node.children.map(prune).filter((child): child is PlanNode => child !== null);
    return { ...node, children };
  };
  const columns = plan.columns.filter((column) => sources.has(column.source.kind));
  if (plan.grain === "summary" && !columns.some((column) => column.aggregate)) {
    columns.push({
      id: nextColumnId(plan, "count"),
      source: { kind: "subject" },
      aggregate: "count",
    });
  }
  return {
    ...plan,
    subject,
    where: prune(plan.where) as PlanGroup,
    columns:
      columns.length > 0
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
      <div className="qb-group-head">
        {depth === 0 && <span className="qb-heading">{message("query.conditions")}</span>}
        <div className="qb-match">
          <MenuSelect
            value={group.match}
            label={message("query.matchLabel")}
            testId={depth === 0 ? "qb-match" : undefined}
            disabled={readonly}
            options={(["all", "any", "none"] as const).map((match) => ({
              value: match,
              label: matchLabel(match, message),
            }))}
            onValueChange={(value) => onChange({ ...group, match: value as PlanGroup["match"] })}
          />
          <span className="qb-label">{message("query.ofTheFollowing")}</span>
        </div>
        {onRemove && (
          <Button
            size="icon"
            className="qb-remove"
            disabled={readonly}
            aria-label={message("query.removeGroup")}
            onClick={onRemove}
          >
            <Trash2Icon aria-hidden />
          </Button>
        )}
      </div>

      <div className="qb-children">
        {group.children.length === 0 && (
          <p className="qb-empty">
            {message(depth === 0 ? "query.noConditions" : "query.emptyGroup")}
          </p>
        )}
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
          ),
        )}
        <div className="qb-add">
          <Button
            variant="ghost"
            className="qb-add-btn"
            disabled={readonly || full}
            data-testid={depth === 0 ? "qb-add-condition" : undefined}
            onClick={() => onChange(appendNode(group, group.id, newCondition()))}
          >
            <PlusIcon aria-hidden />
            {message("query.addCondition")}
          </Button>
          <Button
            variant="ghost"
            className="qb-add-btn"
            disabled={readonly || full || deep}
            data-testid={depth === 0 ? "qb-add-group" : undefined}
            onClick={() => onChange(appendNode(group, group.id, emptyGroup("any")))}
          >
            <PlusIcon aria-hidden />
            {message("query.addGroup")}
          </Button>
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
        value={
          condition.field.kind === "property"
            ? `${FIELD_PROPERTY_PREFIX}${condition.field.key}`
            : condition.field.kind
        }
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
              ? (condition.value ?? defaultValueForField(condition.field))
              : undefined,
            value2: operatorTakesRange(op) ? condition.value2 : undefined,
          });
        }}
      />
      <div className="qb-condition-value">
        {operatorTakesValue(condition.op) && (
          <ValueEditor
            condition={condition}
            snapshot={snapshot}
            readonly={readonly}
            onChange={onChange}
          />
        )}
      </div>
      <Button
        size="icon"
        className="qb-remove"
        disabled={readonly}
        aria-label={message("query.removeCondition", {
          field: fieldLabel(condition.field, subject, message),
        })}
        onClick={onRemove}
      >
        <XIcon aria-hidden />
      </Button>
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
    <div className="qb-range">
      {operand}
      <span className="qb-label">{message("query.and")}</span>
      <Operand
        field={condition.field}
        value={condition.value2 ?? defaultValueForField(condition.field)}
        snapshot={snapshot}
        readonly={readonly}
        onChange={(value) => onChange({ ...condition, value2: value })}
      />
    </div>
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
              onChange({
                type: "date",
                value: value.type === "date" ? value.value : todayLocalDate(),
              });
              return;
            }
            const preset = RELATIVE_DATE_PRESETS.find((item) => item.id === next);
            if (preset) onChange({ type: "relative", value: preset.value });
          }}
        />
        {value.type === "date" && (
          <Input
            type="date"
            className="qb-date-input"
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
        className="qb-number-input"
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
    const page = namedDocuments(snapshot).find((item) => item.id === current);
    return (
      <span className="qb-operand">
        {page && (
          <span className="qb-chip">
            <span>{page.title || page.id}</span>
          </span>
        )}
        {!readonly && (
          <PageAutocomplete
            placeholder={message("query.pickPage")}
            onPick={(id) => onChange({ type: "page", value: id })}
          />
        )}
      </span>
    );
  }

  const choices =
    field.kind === "property" ? offeredChoices(field.key, stringChoicesOf(field.key)) : [];
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
      className="qb-text-input"
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
  const choices =
    condition.field.kind === "property"
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
      const page = namedDocuments(snapshot).find((item) => item.id === member);
      return page ? page.title || page.id : member;
    }
    return member;
  };

  const remaining =
    type === "tag"
      ? snapshot.tags
          .filter((tag) => !members.includes(tag.id))
          .map((tag) => ({ value: tag.id, label: tag.name }))
      : choices
          .filter((choice) => !members.includes(choice))
          .map((choice) => ({ value: choice, label: choice }));

  return (
    <span className="qb-operand qb-list" data-testid="qb-value-list">
      {members.map((member) => (
        <span key={member} className="qb-chip">
          <span>{nameOf(member)}</span>
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
          className="qb-text-input"
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
