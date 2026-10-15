import { namedDocuments } from "../../entities/names";
import { NumberField } from "@/ui/NumberField";
import { useMemo, useRef, useState } from "react";
import { MoreHorizontalIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";
import { AnchoredPanel } from "@/ui/anchored-panel";
import { elementAnchor } from "@/ui/anchored";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/ui/shadcn/dropdown-menu";
import { FilterPicker } from "./FilterPicker";
import { conditionPhrase, type SummaryContext } from "./summary";
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
  sourceType,
  graphPropertyKeys,
  queryFieldId,
  queryFieldsFor,
  newCondition,
  nextColumnId,
  operatorsFor,
  operatorTakesList,
  operatorTakesRange,
  operatorTakesValue,
  valueForOperator,
  PLAN_ANY_OF_MAX,
  PLAN_LIMIT_MAX,
  PLAN_MAX_CONDITIONS,
  PLAN_MAX_DEPTH,
  PLAN_SUBJECTS,
  replaceNode,
  aggregatesFor,
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
  graphPropertyTypes,
  type PropertyTypes,
} from "../../entities/query-plan";
import { todayLocalDate } from "../../entities/journal";
import { useI18n } from "../../i18n";
import { PageAutocomplete } from "../properties/PageAutocomplete";
import {
  choiceLabel,
  aggregateLabel,
  columnSourceLabel,
  fieldLabel,
  operatorLabel,
  RELATIVE_DATE_PRESETS,
  relativeDateId,
  relativeDateLabel,
  subjectLabel,
} from "./labels";

const FIELD_PROPERTY_PREFIX = "property:";
const EXACT_DATE = "exact";

/**
 * A query reads as a sentence: what it finds, the filters that narrow it, and
 * how its answer is shown. Each filter is one phrase; pressing it opens an editor
 * for that filter alone, and the words between filters are how they combine.
 */
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
  const { message, formatJournalDate } = useI18n();
  const propertyKeys = useMemo(() => graphPropertyKeys(snapshot), [snapshot]);
  const propertyTypes = graphPropertyTypes(snapshot);
  const [editing, setEditing] = useState<{ id: string; fresh: boolean } | null>(null);
  const [adding, setAdding] = useState<string | null>(null);

  const context: BuilderContext = {
    plan,
    snapshot,
    readonly,
    propertyKeys,
    propertyTypes,
    phrase: { snapshot, message, formatDate: formatJournalDate },
    full: countConditions(plan.where) >= PLAN_MAX_CONDITIONS,
    deep: groupDepth(plan.where) >= PLAN_MAX_DEPTH,
    editing,
    setEditing,
    adding,
    setAdding,
  };

  return (
    <div className="query-builder" id={id} data-testid="query-builder">
      <div className="qb-line">
        <span className="qb-word">{message("query.find")}</span>
        <MenuSelect
          className="qb-token qb-subject"
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

      <GroupView
        group={plan.where}
        depth={0}
        context={context}
        onChange={(where) => onChange({ ...plan, where })}
        onRemove={null}
      />

      <div className="qb-line qb-output">
        <span className="qb-word">{message("query.grain")}</span>
        <MenuSelect
          className="qb-token"
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
        <span className="qb-word">{message("query.upTo")}</span>
        <NumberField
          // Utilities size the shared field; here it is a word-sized token.
          className="qb-limit h-7 w-[72px] font-medium tabular-nums"
          min={1}
          max={PLAN_LIMIT_MAX}
          value={plan.limit}
          readOnly={readonly}
          aria-label={message("query.limit")}
          data-testid="qb-limit"
          valid={(limit) => Number.isInteger(limit) && limit >= 1 && limit <= PLAN_LIMIT_MAX}
          onValue={(limit) => onChange({ ...plan, limit })}
        />
      </div>
      {plan.grain === "summary" && (
        <div className="qb-summary">
          <span className="qb-word">{message("query.summaryFields")}</span>
          <SummaryColumns
            plan={plan}
            propertyKeys={propertyKeys}
            propertyTypes={propertyTypes}
            readonly={readonly}
            onChange={onChange}
          />
        </div>
      )}
    </div>
  );
}

interface BuilderContext {
  plan: QueryPlan;
  snapshot: GraphSnapshot;
  readonly: boolean;
  propertyKeys: string[];
  propertyTypes: PropertyTypes;
  phrase: SummaryContext;
  /** The tree holds as many conditions as a plan may. */
  full: boolean;
  /** The tree is as deep as a plan may nest. */
  deep: boolean;
  /** The filter whose editor is open; `fresh` when it was just added. */
  editing: { id: string; fresh: boolean } | null;
  setEditing: (editing: { id: string; fresh: boolean } | null) => void;
  /** The group whose field list is open. */
  adding: string | null;
  setAdding: (group: string | null) => void;
}

function SummaryColumns({
  plan,
  propertyKeys,
  propertyTypes,
  readonly,
  onChange,
}: {
  plan: QueryPlan;
  propertyKeys: string[];
  propertyTypes: PropertyTypes;
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
              ...aggregatesFor(column.source, propertyTypes).map((aggregate) => ({
                value: aggregate,
                label: aggregateLabel(aggregate, message, sourceType(column.source, propertyTypes)),
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
              if (!source) return;
              // A computation the new field cannot take falls back to counting it.
              const fits =
                !column.aggregate ||
                aggregatesFor(source, propertyTypes).includes(column.aggregate);
              update(column.id, fits ? { source } : { source, aggregate: "count" });
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

function GroupView({
  group,
  depth,
  context,
  onChange,
  onRemove,
}: {
  group: PlanGroup;
  depth: number;
  context: BuilderContext;
  onChange: (group: PlanGroup) => void;
  onRemove: (() => void) | null;
}) {
  const { message } = useI18n();
  const { plan, readonly } = context;
  const addRef = useRef<HTMLButtonElement>(null);
  const replaceChild = (id: string, next: PlanNode | null) =>
    onChange(replaceNode(group, id, next));
  const fields = queryFieldsFor(plan.subject, context.propertyKeys).map((field) => ({
    field,
    label: fieldLabel(field, plan.subject, message),
  }));

  return (
    <div
      className={depth === 0 ? "qb-filters" : "qb-group"}
      data-depth={depth}
      data-testid="qb-group"
    >
      {onRemove && !readonly && <GroupMenu group={group} onChange={onChange} onRemove={onRemove} />}
      {depth > 0 && group.children.length === 0 && (
        <p className="qb-empty">{message("query.emptyGroup")}</p>
      )}
      {group.children.map((child, index) => (
        <div className="qb-row" key={child.id}>
          <Combiner
            group={group}
            index={index}
            depth={depth}
            context={context}
            onChange={onChange}
          />
          {child.kind === "group" ? (
            <GroupView
              group={child}
              depth={depth + 1}
              context={context}
              onChange={(next) => replaceChild(child.id, next)}
              onRemove={() => replaceChild(child.id, null)}
            />
          ) : (
            <FilterRow
              condition={child}
              context={context}
              onChange={(next) => replaceChild(child.id, next)}
              onRemove={() => replaceChild(child.id, null)}
            />
          )}
        </div>
      ))}
      {!readonly && (
        <div className="qb-row">
          <span className="qb-combiner" />
          <button
            ref={addRef}
            type="button"
            className="qb-add-filter"
            disabled={context.full}
            aria-haspopup="dialog"
            aria-expanded={context.adding === group.id}
            data-testid={depth === 0 ? "qb-add-condition" : undefined}
            onClick={() => context.setAdding(context.adding === group.id ? null : group.id)}
          >
            <PlusIcon aria-hidden />
            {message("query.addFilter")}
          </button>
          {context.adding === group.id && (
            <FilterPicker
              anchor={() => elementAnchor(addRef.current)}
              fields={fields}
              onPick={(field) => {
                const condition = newCondition(field, context.propertyTypes);
                onChange(appendNode(group, group.id, condition));
                context.setAdding(null);
                context.setEditing({ id: condition.id, fresh: true });
              }}
              onGroup={
                context.deep
                  ? undefined
                  : () => {
                      onChange(appendNode(group, group.id, emptyGroup("any")));
                      context.setAdding(null);
                    }
              }
              onClose={() => context.setAdding(null)}
            />
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The word before a filter: how it combines with the ones above. A group has one
 * way of combining, so every word in it names that way, and any of them changes
 * it. An excluding group says so before its first filter.
 */
function Combiner({
  group,
  index,
  depth,
  context,
  onChange,
}: {
  group: PlanGroup;
  index: number;
  depth: number;
  context: BuilderContext;
  onChange: (group: PlanGroup) => void;
}) {
  const { message } = useI18n();
  const word =
    index > 0
      ? message(group.match === "all" ? "query.joiner.all" : "query.joiner.any")
      : group.match === "none"
        ? message("query.joiner.none")
        : depth === 0
          ? message("query.where")
          : null;
  if (word === null) return <span className="qb-combiner" />;
  // `where` introduces the list; it is not a choice between ways of combining.
  if (context.readonly || (index === 0 && group.match !== "none")) {
    return <span className="qb-combiner">{word}</span>;
  }
  return (
    <span className="qb-combiner">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="qb-combiner-token"
            aria-label={message("query.matchLabel")}
            data-testid={depth === 0 ? "qb-match" : undefined}
          >
            {word}
          </button>
        </DropdownMenuTrigger>
        <MatchMenu group={group} onChange={onChange} />
      </DropdownMenu>
    </span>
  );
}

function MatchMenu({
  group,
  onChange,
}: {
  group: PlanGroup;
  onChange: (group: PlanGroup) => void;
}) {
  const { message } = useI18n();
  return (
    <DropdownMenuContent align="start">
      <DropdownMenuRadioGroup
        value={group.match}
        onValueChange={(value) => onChange({ ...group, match: value as PlanGroup["match"] })}
      >
        {(["all", "any", "none"] as const).map((match) => (
          <DropdownMenuRadioItem key={match} value={match}>
            {message(`query.mode.${match}`)}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  );
}

function GroupMenu({
  group,
  onChange,
  onRemove,
}: {
  group: PlanGroup;
  onChange: (group: PlanGroup) => void;
  onRemove: () => void;
}) {
  const { message } = useI18n();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="icon"
          variant="ghost"
          className="qb-group-menu"
          aria-label={message("query.groupActions")}
        >
          <MoreHorizontalIcon aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={group.match}
          onValueChange={(value) => onChange({ ...group, match: value as PlanGroup["match"] })}
        >
          {(["all", "any", "none"] as const).map((match) => (
            <DropdownMenuRadioItem key={match} value={match}>
              {message(`query.mode.${match}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onSelect={onRemove}>
          <Trash2Icon aria-hidden />
          {message("query.removeGroup")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One filter as a phrase; pressing it edits that filter alone. */
function FilterRow({
  condition,
  context,
  onChange,
  onRemove,
}: {
  condition: PlanCondition;
  context: BuilderContext;
  onChange: (condition: PlanCondition) => void;
  onRemove: () => void;
}) {
  const { message } = useI18n();
  const { plan, snapshot, readonly } = context;
  const trigger = useRef<HTMLButtonElement>(null);
  const editor = useRef<HTMLDivElement>(null);
  const open = context.editing?.id === condition.id;
  const phrase = conditionPhrase(condition, plan.subject, context.phrase);
  const text = [phrase.field, phrase.operator, phrase.value].filter(Boolean).join(" ");
  const words = (
    <>
      {/* Real spaces, so the phrase is also read and copied as one. */}
      <span className="qb-filter-field">{phrase.field}</span>{" "}
      <span className="qb-filter-operator">{phrase.operator}</span>
      {phrase.value !== null && " "}
      {phrase.value !== null &&
        (phrase.value ? (
          <span className="qb-filter-value">{phrase.value}</span>
        ) : (
          // A comparison still waiting for its operand says so.
          <span className="qb-filter-missing">{message("query.valueMissing")}</span>
        ))}
    </>
  );

  const fieldOptions: MenuSelectOption[] = queryFieldsFor(plan.subject, context.propertyKeys).map(
    (field) => ({ value: queryFieldId(field), label: fieldLabel(field, plan.subject, message) }),
  );
  const changeField = (encoded: string) => {
    const field: PlanField = encoded.startsWith(FIELD_PROPERTY_PREFIX)
      ? { kind: "property", key: encoded.slice(FIELD_PROPERTY_PREFIX.length) }
      : ({ kind: encoded } as PlanField);
    const next = operatorsFor(field, context.propertyTypes);
    const op = next.includes(condition.op) ? condition.op : next[0];
    onChange({
      ...condition,
      field,
      op,
      // A new field starts from its own default, in the shape the operator takes.
      value: valueForOperator(op, field, undefined, context.propertyTypes),
      value2: undefined,
    });
  };

  return (
    <div className="qb-filter-row" data-testid="qb-condition">
      {readonly ? (
        <span className="qb-filter" title={text}>
          {words}
        </span>
      ) : (
        <button
          ref={trigger}
          type="button"
          className="qb-filter"
          title={text}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => context.setEditing(open ? null : { id: condition.id, fresh: false })}
        >
          {words}
        </button>
      )}
      {!readonly && (
        <Button
          size="icon"
          variant="ghost"
          className="qb-remove"
          aria-label={message("query.removeCondition", {
            field: fieldLabel(condition.field, plan.subject, message),
          })}
          onClick={onRemove}
        >
          <XIcon aria-hidden />
        </Button>
      )}
      {open && (
        <AnchoredPanel
          anchor={() => elementAnchor(trigger.current)}
          className="qb-filter-editor"
          label={message("query.editFilter")}
          options={{ width: 380 }}
          surfaceRef={editor}
          // A filter just added is waiting for its value; an existing one opens
          // on what it asks about.
          initialFocus={() =>
            (context.editing?.fresh
              ? editor.current?.querySelector<HTMLElement>(
                  ".qb-filter-value-editor :is(button, input):not(:disabled)",
                )
              : null) ??
            editor.current?.querySelector<HTMLElement>("button, input") ??
            null
          }
          testId="qb-filter-editor"
          onClose={() => context.setEditing(null)}
        >
          <div className="qb-filter-editor-head">
            <MenuSelect
              className="qb-field"
              value={queryFieldId(condition.field)}
              label={message("query.fieldLabel")}
              testId="qb-field"
              options={fieldOptions}
              onValueChange={changeField}
            />
            <MenuSelect
              className="qb-operator"
              value={condition.op}
              label={message("query.operatorLabel")}
              testId="qb-operator"
              options={operatorsFor(condition.field, context.propertyTypes).map((op) => ({
                value: op,
                label: operatorLabel(
                  op,
                  message,
                  fieldType(condition.field, context.propertyTypes),
                ),
              }))}
              onValueChange={(value) => {
                const op = value as PlanCondition["op"];
                onChange({
                  ...condition,
                  op,
                  value: valueForOperator(
                    op,
                    condition.field,
                    condition.value,
                    context.propertyTypes,
                  ),
                  value2: operatorTakesRange(op) ? condition.value2 : undefined,
                });
              }}
            />
          </div>
          {operatorTakesValue(condition.op) && (
            <div className="qb-filter-value-editor">
              <ValueEditor
                condition={condition}
                snapshot={snapshot}
                readonly={readonly}
                onChange={onChange}
              />
            </div>
          )}
        </AnchoredPanel>
      )}
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
      value={condition.value ?? defaultValueForField(condition.field, graphPropertyTypes(snapshot))}
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
        value={
          condition.value2 ?? defaultValueForField(condition.field, graphPropertyTypes(snapshot))
        }
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
  const type = fieldType(field, graphPropertyTypes(snapshot));

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
      <NumberField
        className="qb-number-input"
        value={value.type === "number" ? value.value : 0}
        readOnly={readonly}
        aria-label={message("query.valueLabel")}
        data-testid="qb-value"
        onValue={(next) => onChange({ type: "number", value: next })}
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
  const type = fieldType(condition.field, graphPropertyTypes(snapshot));
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

  // Members are stored as values and named as the single-value select names them.
  const nameOf = (member: string): string => {
    if (condition.field.kind === "property" && choices.length > 0) {
      return choiceLabel(condition.field.key, member, message);
    }
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
          .map((choice) => ({ value: choice, label: nameOf(choice) }));

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
