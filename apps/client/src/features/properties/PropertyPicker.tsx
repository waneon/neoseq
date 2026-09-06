import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeftIcon, CalendarIcon, CheckIcon, Trash2Icon } from "lucide-react";
import type { Command, PropertyChange, PropertyOwnerRef } from "../../core-port/commands";
import type { PropertyField, PropertyValue, PropertyValueType } from "../../core-port/snapshot";
import { findPage, isDeleted, pageTitle } from "../../core-port/snapshot";
import {
  canUserWrite,
  cardinalityOf,
  defaultValueFor,
  formatValue,
  isGenericProperty,
  REGISTRY,
  stringChoicesOf,
  validateKey,
  validateValue,
  validateWriteTarget,
  valueTypeOf,
  VALUE_TYPES,
} from "../../entities/properties";
import { todayLocalDate } from "../../entities/journal";
import { addDays } from "../../entities/calendar";
import {
  DEFAULT_REPEAT,
  formatRepeat,
  isTaskDateKey,
  offeredChoices,
  parseRepeat,
  REPEAT_UNITS,
  TASK_PRIORITY_KEY,
  TASK_REPEAT_KEY,
  TASK_SCHEDULED_KEY,
  TASK_STATUS_KEY,
  timeKeyFor,
  type RepeatUnit,
} from "../../entities/tasks";
import type { Anchor } from "@/ui/anchored";
import { AnchoredPanel } from "@/ui/anchored-panel";
import { Button } from "@/ui/shadcn/button";
import { Input } from "@/ui/shadcn/input";
import {
  Autocomplete,
  SearchField,
  Input as AriaInput,
  ListBox,
  ListBoxItem,
} from "react-aria-components";
import { MenuSelect } from "@/ui/menu-select";
import { useI18n } from "../../i18n";
import type { AsyncRequestState } from "../../lib/async";
import { useNotify } from "../notify/context";
import { useSession, useSessionSelector } from "../shell/session-context";
import { PriorityGlyph, TaskStatusGlyph } from "../tasks/glyphs";
import { priorityLabel, repeatLabel, repeatUnitLabel, statusLabel } from "../tasks/labels";
import { PageAutocomplete } from "./PageAutocomplete";
import { TaskMomentPicker } from "./TaskMomentPicker";
import {
  propertyDisplayName,
  propertyGlyph,
  storageKeyForQuery,
  TypeGlyph,
} from "./property-display";
import { validationMessage } from "./property-validation";
import { createQueryCommand } from "../query/commands";

export interface PropertyTarget {
  owner: PropertyOwnerRef;
  bag: PropertyField[];
}

type PickerStage =
  | { kind: "property" }
  | { kind: "type"; key: string }
  | { kind: "value"; key: string; valueType: PropertyValueType; draft: PropertyValue };

interface Candidate {
  key: string;
  existing: boolean;
  create: boolean;
}

export function PropertyPicker({
  target,
  anchor,
  initialKey,
  commandPrefix,
  returnFocus,
  onClose,
}: {
  target: PropertyTarget;
  anchor: Anchor;
  initialKey?: string;
  /** A completion-token edit that must commit with the chosen property. */
  commandPrefix?: Command;
  returnFocus?: () => HTMLElement | null;
  onClose: () => void;
}) {
  const session = useSession();
  const state = useSessionSelector(
    (current) => current,
    (left, right) => left.snapshot === right.snapshot && left.mode === right.mode,
  );
  const notify = useNotify();
  const { message, compare } = useI18n();
  const readonly = state.mode === "readonly";
  const initial = initialKey?.trim() || null;
  const [stage, setStage] = useState<PickerStage>(() => initialStage(initial, target.bag));
  const [query, setQuery] = useState("");
  const [request, setRequest] = useState<AsyncRequestState>({ status: "idle" });
  const committing = request.status === "busy";
  const submitting = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const prefixPending = useRef(commandPrefix);
  const key = stage.kind === "property" ? null : stage.key;

  const { owner } = target;
  const writeTarget = owner.kind === "tag" ? "tag_metadata" : owner.kind;
  const selectedUnsupported =
    key !== null &&
    target.bag
      .find((field) => field.key === key)
      ?.values.some((value) => value.type === "unsupported_document");
  const writeDisabled =
    readonly || selectedUnsupported || (key !== null && !canUserWrite(key, writeTarget));

  const resetStage = useCallback(() => {
    setStage({ kind: "property" });
    setRequest({ status: "idle" });
  }, []);

  useEffect(() => {
    const invokingElement = anchor?.geometry.kind === "element" ? anchor.geometry.element : null;
    if (!invokingElement) return;
    const reopenAtAnchor = () => {
      if (submitting.current) return;
      setStage(initialStage(initial, target.bag));
      setQuery("");
      setRequest({ status: "idle" });
    };
    invokingElement.addEventListener("click", reopenAtAnchor);
    return () => invokingElement.removeEventListener("click", reopenAtAnchor);
  }, [anchor, initial, target.bag]);

  useEffect(() => {
    if (stage.kind === "property") {
      searchRef.current?.focus({ preventScroll: true });
      return;
    }
    if (panelRef.current?.contains(document.activeElement)) return;
    // Choice-only value editors have no autofocus input. The new stage owns
    // focus immediately; closing menus preserve that explicit transfer.
    panelRef.current
      ?.querySelector<HTMLElement>(
        '.property-picker-list [role="option"]:not([disabled]), .property-picker-value input:not([disabled]), .property-picker-value button:not([disabled])',
      )
      ?.focus({ preventScroll: true });
  }, [stage.kind]);

  const visibleEntries = useMemo(
    () => target.bag.filter((entry) => isGenericProperty(entry.key)),
    [target.bag],
  );
  const candidates = useMemo<Candidate[]>(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const present = new Set(visibleEntries.map((entry) => entry.key));
    const known = Object.keys(REGISTRY).filter(
      (key) =>
        (isGenericProperty(key) ||
          (key === "builtin.query" && !target.bag.some((field) => field.key === key))) &&
        canUserWrite(key, writeTarget),
    );
    // A query reaches a key through its storage name OR the name it goes by on
    // screen, so "예정" finds builtin.task-scheduled and "effort" finds
    // user.effort alike.
    const keys = [...new Set([...visibleEntries.map((entry) => entry.key), ...known])]
      .filter(
        (item) =>
          !normalized ||
          item.toLocaleLowerCase().includes(normalized) ||
          propertyDisplayName(item, message).toLocaleLowerCase().includes(normalized),
      )
      .sort((left, right) => {
        const existing = Number(present.has(right)) - Number(present.has(left));
        return (
          existing ||
          compare(propertyDisplayName(left, message), propertyDisplayName(right, message))
        );
      });
    const result = keys.map((item) => ({ key: item, existing: present.has(item), create: false }));
    // A bare name is a user property waiting to exist: typing `effort` offers
    // to create `user.effort`. The prefix is storage routing, not something the
    // user should have to type or read.
    const storageKey = storageKeyForQuery(query);
    const exact = keys.some((item) => item === storageKey);
    if (
      normalized &&
      !exact &&
      !validateKey(storageKey) &&
      !validateWriteTarget(storageKey, writeTarget)
    ) {
      result.push({ key: storageKey, existing: false, create: true });
    }
    return result.slice(0, 12);
  }, [compare, message, query, writeTarget, visibleEntries, target.bag]);

  const run = async (command: Command): Promise<boolean> => {
    if (submitting.current) return false;
    submitting.current = true;
    setRequest({ status: "busy" });
    try {
      const prefix = prefixPending.current;
      await session.execute(prefix ? { type: "batch", commands: [prefix, command] } : command);
      prefixPending.current = undefined;
      setRequest({ status: "idle" });
      return true;
    } catch (cause) {
      notify.failure(message("failure.setProperty"), cause);
      setRequest({ status: "failed", message: message("failure.setProperty") });
      return false;
    } finally {
      submitting.current = false;
    }
  };

  const close = () => {
    // The prefix already belongs to the pending batch. Dismissal cannot submit
    // it again or discard this editor's error/retry surface before it resolves.
    if (submitting.current) return;
    const prefix = prefixPending.current;
    prefixPending.current = undefined;
    if (prefix) {
      void session.execute(prefix).catch((cause: unknown) => {
        notify.failure(message("failure.lastEdit"), cause);
      });
    }
    onClose();
  };

  const chooseKey = (candidate: Candidate) => {
    if (candidate.key === "builtin.query") {
      if (readonly || owner.kind === "tag_default") return;
      void run(createQueryCommand(owner)).then((saved) => {
        if (saved) close();
      });
      return;
    }
    const found = target.bag.find((field) => field.key === candidate.key);
    const nextType = valueTypeOf(candidate.key) ?? found?.value_type;
    setQuery("");
    if (!nextType) {
      setStage({ kind: "type", key: candidate.key });
      return;
    }
    setStage({
      kind: "value",
      key: candidate.key,
      valueType: nextType,
      draft: found?.values[0] ?? defaultValueFor(nextType, todayLocalDate()),
    });
  };

  const chooseType = (nextType: PropertyValueType) => {
    if (stage.kind !== "type") return;
    setStage({
      kind: "value",
      key: stage.key,
      valueType: nextType,
      draft: defaultValueFor(nextType, todayLocalDate()),
    });
  };

  const commit = async (value: PropertyValue) => {
    if (stage.kind !== "value" || writeDisabled) return;
    const { key } = stage;
    const keyIssue = validateKey(key);
    const existing = target.bag.find((field) => field.key === key);
    const cardinality = existing?.cardinality ?? cardinalityOf(key);
    const issue =
      keyIssue ?? validateWriteTarget(key, writeTarget) ?? validateValue(key, value, cardinality);
    if (issue) {
      setRequest({ status: "failed", message: validationMessage(issue, message) });
      return;
    }
    const repeated = cardinality === "set";
    const saved = await run(
      repeated
        ? { type: "add_repeated_property", owner, key, value }
        : { type: "set_property", owner, key, value },
    );
    if (!saved) return;
    close();
  };

  const ensureEmpty = async () => {
    if (stage.kind !== "value" || writeDisabled) return;
    const { key, valueType } = stage;
    const cardinality = cardinalityOf(key);
    const saved = await run({
      type: "ensure_property",
      owner,
      key,
      value_type: valueType,
      cardinality,
    });
    if (saved) close();
  };

  const removeValue = async (value: PropertyValue) => {
    if (stage.kind !== "value" || writeDisabled) return;
    const { key } = stage;
    const removed = await run({ type: "remove_repeated_property", owner, key, value });
    if (removed) close();
  };

  const clearValues = async () => {
    if (stage.kind !== "value" || writeDisabled) return;
    const { key } = stage;
    const cleared = await run({ type: "clear_property_values", owner, key });
    if (cleared) close();
  };

  const removeField = async () => {
    if (stage.kind !== "value" || writeDisabled) return;
    const { key } = stage;
    const removed = await run({ type: "remove_property", owner, key });
    if (removed) close();
  };

  const commitMoment = async (
    date: string,
    time: string | null,
    repeat: string | null | undefined,
  ) => {
    if (stage.kind !== "value" || !isTaskDateKey(stage.key) || writeDisabled) return;
    const timeKey = timeKeyFor(stage.key);
    const dateValue = { type: "date", value: date } as const;
    const timeValue = time === null ? null : ({ type: "string", value: time } as const);
    const repeatValue =
      repeat === null
        ? null
        : repeat === undefined
          ? undefined
          : ({ type: "string", value: repeat } as const);
    const issue =
      validateWriteTarget(stage.key, writeTarget) ??
      validateValue(stage.key, dateValue, "single") ??
      (timeValue ? validateValue(timeKey, timeValue, "single") : null) ??
      validateWriteTarget(timeKey, writeTarget) ??
      (repeatValue === undefined ? null : validateWriteTarget(TASK_REPEAT_KEY, writeTarget)) ??
      (repeatValue ? validateValue(TASK_REPEAT_KEY, repeatValue, "single") : null);
    if (issue) {
      setRequest({ status: "failed", message: validationMessage(issue, message) });
      return;
    }
    const changes: PropertyChange[] = [
      { key: stage.key, value: dateValue },
      { key: timeKey, value: timeValue },
    ];
    if (repeatValue !== undefined) {
      changes.push({ key: TASK_REPEAT_KEY, value: repeatValue });
    }
    const saved = await run({
      type: "set_properties",
      owner,
      changes,
    });
    if (saved) close();
  };

  const clearMoment = async () => {
    if (stage.kind !== "value" || !isTaskDateKey(stage.key) || writeDisabled) return;
    const cleared = await run({
      type: "set_properties",
      owner,
      changes: [
        { key: stage.key, value: null },
        { key: timeKeyFor(stage.key), value: null },
      ],
    });
    if (cleared) close();
  };

  const selectedField = key ? visibleEntries.find((field) => field.key === key) : undefined;
  const selectedValues = selectedField?.values ?? [];
  const choices = key ? offeredChoices(key, stringChoicesOf(key)) : [];
  const selectedCardinality =
    key === null ? "single" : (selectedField?.cardinality ?? cardinalityOf(key));
  const taskMoment =
    stage.kind === "value" && isTaskDateKey(stage.key)
      ? { key: stage.key, draft: stage.draft }
      : null;
  // Report a bad key only when it is a dead end — while matches are still on
  // screen the query is a search, not a mistake.
  const queryIssue =
    stage.kind === "property" && query.trim() && candidates.length === 0
      ? validateKey(storageKeyForQuery(query))
      : null;
  const describeValue = (value: PropertyValue): string => {
    if (value.type === "document") {
      const view = value.value.views.find((item) => item.id === value.value.default_view_id);
      return view?.name ?? value.value.schema;
    }
    if (value.type === "unsupported_document") {
      return `${value.value.schema} v${value.value.version}`;
    }
    if (value.type === "checkbox")
      return value.value ? message("properties.checked") : message("properties.unchecked");
    if (value.type === "page") {
      const page = findPage(state.snapshot, value.value);
      if (!page) return value.value;
      return isDeleted(page)
        ? message("properties.deleted", { name: pageTitle(page) })
        : pageTitle(page);
    }
    return String(value.value);
  };
  const describeField = (field: PropertyField): string =>
    field.values.length === 0
      ? message("properties.noValue")
      : field.values.map(describeValue).join(", ");

  return (
    <AnchoredPanel
      anchor={anchor}
      className="property-picker"
      label={message("properties.addOrChange")}
      options={{
        width: taskMoment ? 640 : 360,
        minWidth: 280,
        maxHeight: taskMoment ? 480 : 420,
      }}
      revision={stage.kind}
      testId="property-picker"
      surfaceRef={panelRef}
      dismissOnExternalScroll
      onClose={close}
      returnFocus={returnFocus}
      onEscapeKeyDown={(event) => {
        if (submitting.current) {
          event.preventDefault();
          return;
        }
        if (stage.kind === "property") return;
        event.preventDefault();
        resetStage();
      }}
      // Pointer dismissal remains Radix's. Focus alone may leave briefly when
      // the command or chip that opened this staged editor restores itself.
      onFocusOutside={(event) => event.preventDefault()}
    >
      <div className="property-picker-head">
        {stage.kind !== "property" && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={message("properties.back")}
            disabled={committing}
            onClick={() => {
              resetStage();
            }}
          >
            <ArrowLeftIcon data-icon aria-hidden />
          </Button>
        )}
        <div>
          <strong title={key ?? undefined}>
            {stage.kind === "property"
              ? message("properties.addOrChange")
              : propertyDisplayName(stage.key, message)}
          </strong>
          {stage.kind === "value" && !taskMoment && (
            <span>{message(`properties.type.${stage.valueType}`)}</span>
          )}
        </div>
      </div>

      {stage.kind === "property" && (
        <>
          <Autocomplete inputValue={query} onInputChange={setQuery}>
            <SearchField aria-label={message("properties.propertyKey")}>
              <AriaInput
                render={(props) => <Input {...props} />}
                ref={searchRef}
                autoFocus
                placeholder={message("properties.propertyKey")}
              />
            </SearchField>
            <ListBox
              aria-label={message("properties.addOrChange")}
              className="property-picker-list"
              items={candidates}
              onAction={(id) => {
                const candidate = candidates.find((candidate) => candidate.key === id);
                if (candidate) chooseKey(candidate);
              }}
              renderEmptyState={() => <p className="ac-hint">{message("properties.noKeys")}</p>}
            >
              {(candidate) => (
                <ListBoxItem
                  id={candidate.key}
                  textValue={propertyDisplayName(candidate.key, message)}
                  className="property-picker-option"
                >
                  {candidate.create ? (
                    <TypeGlyph type={undefined} />
                  ) : (
                    propertyGlyph(
                      candidate.key,
                      valueTypeOf(candidate.key) ??
                        target.bag.find((field) => field.key === candidate.key)?.value_type,
                    )
                  )}
                  <span className="property-picker-candidate">
                    <span className={candidate.key.startsWith("builtin.") ? undefined : "mono"}>
                      {candidate.create
                        ? message("properties.createProperty", {
                            key: propertyDisplayName(candidate.key, message),
                          })
                        : propertyDisplayName(candidate.key, message)}
                    </span>
                    {candidate.existing && (
                      <small>
                        {describeField(
                          visibleEntries.find((field) => field.key === candidate.key)!,
                        )}
                      </small>
                    )}
                  </span>
                  {candidate.existing && <CheckIcon data-icon aria-hidden />}
                </ListBoxItem>
              )}
            </ListBox>
          </Autocomplete>
          {queryIssue && (
            <p className="field-error" role="alert" data-testid="props-error">
              {validationMessage(queryIssue, message)}
            </p>
          )}
        </>
      )}

      {stage.kind === "type" && (
        <ListBox
          className="property-picker-list"
          aria-label={message("properties.newType")}
          disabledKeys={readonly ? VALUE_TYPES : []}
          onAction={(key) => chooseType(key as PropertyValueType)}
        >
          {VALUE_TYPES.map((valueType) => (
            <ListBoxItem
              id={valueType}
              key={valueType}
              textValue={message(`properties.type.${valueType}`)}
              className="property-picker-option"
            >
              <TypeGlyph type={valueType} />
              <span className="property-picker-candidate">
                <span>{message(`properties.type.${valueType}`)}</span>
              </span>
            </ListBoxItem>
          ))}
        </ListBox>
      )}

      {stage.kind === "value" && (
        <div className="property-picker-value">
          {!taskMoment && selectedCardinality === "set" && selectedValues.length > 0 && (
            <div className="property-picker-members">
              {selectedValues.map((value, index) => (
                <div key={`${stage.key}:${index}`}>
                  <span>{formatValue(value)}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={writeDisabled || committing}
                    aria-label={message("properties.removeValue", {
                      key: propertyDisplayName(stage.key, message),
                    })}
                    onClick={() => void removeValue(value)}
                  >
                    <Trash2Icon data-icon aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
          )}
          {!taskMoment && selectedCardinality === "single" && selectedValues[0] && (
            <p className="property-current-value">{describeValue(selectedValues[0])}</p>
          )}
          {!taskMoment && selectedField && selectedValues.length === 0 && (
            <p className="property-current-value">{message("properties.noValue")}</p>
          )}
          {taskMoment ? (
            <TaskMomentPicker
              date={taskMoment.draft.type === "date" ? taskMoment.draft.value : todayLocalDate()}
              time={singleString(target.bag, timeKeyFor(taskMoment.key))}
              repeat={singleString(target.bag, TASK_REPEAT_KEY)}
              hasValue={selectedValues.some((value) => value.type === "date")}
              readonly={writeDisabled}
              busy={committing}
              clearLabel={message(
                taskMoment.key === TASK_SCHEDULED_KEY
                  ? "task.clearScheduled"
                  : "task.clearDeadline",
              )}
              onApply={(date, time, repeat) => void commitMoment(date, time, repeat)}
              onClear={() => void clearMoment()}
              onCancel={close}
            />
          ) : (
            <ValueInput
              entryKey={stage.key}
              type={stage.valueType}
              value={stage.draft}
              allowed={choices}
              readonly={writeDisabled || committing}
              onChange={(draft) => {
                setStage((current) => (current.kind === "value" ? { ...current, draft } : current));
              }}
              onCommit={(value) => void commit(value)}
              onCreatePage={(id) => {
                const command: Command =
                  selectedCardinality === "set"
                    ? {
                        type: "add_repeated_property",
                        owner,
                        key: stage.key,
                        value: { type: "page", value: id },
                      }
                    : {
                        type: "set_property",
                        owner,
                        key: stage.key,
                        value: { type: "page", value: id },
                      };
                return prefixPending.current ? [prefixPending.current, command] : command;
              }}
              onPageCreated={() => {
                prefixPending.current = undefined;
                close();
              }}
            />
          )}
          {!taskMoment && (
            <div className="property-picker-actions">
              {!selectedField && (
                <Button
                  variant="secondary"
                  onClick={() => void ensureEmpty()}
                  disabled={writeDisabled || committing}
                >
                  {message("properties.addEmpty")}
                </Button>
              )}
              {selectedField && selectedValues.length > 0 && stage.valueType !== "document" && (
                <Button
                  variant="secondary"
                  onClick={() => void clearValues()}
                  disabled={writeDisabled || committing}
                >
                  {message("properties.clear")}
                </Button>
              )}
              {selectedField && (
                <Button
                  variant="destructive"
                  onClick={() => void removeField()}
                  disabled={writeDisabled || committing}
                >
                  <Trash2Icon data-icon aria-hidden />
                  {message("properties.removeProperty")}
                </Button>
              )}
              {stage.valueType !== "page" &&
                stage.valueType !== "date" &&
                stage.key !== TASK_REPEAT_KEY &&
                choices.length === 0 && (
                  <Button
                    onClick={() => void commit(stage.draft)}
                    disabled={writeDisabled || committing}
                    data-testid="property-set"
                  >
                    {message("properties.set")}
                  </Button>
                )}
            </div>
          )}
        </div>
      )}

      {request.status === "failed" && (
        <p className="field-error" role="alert" data-testid="props-error">
          {request.message}
        </p>
      )}
    </AnchoredPanel>
  );
}

function initialStage(key: string | null, bag: PropertyField[]): PickerStage {
  if (!key) return { kind: "property" };
  const existing = bag.find((field) => field.key === key)?.values[0];
  const valueType =
    valueTypeOf(key) ?? bag.find((field) => field.key === key)?.value_type ?? "string";
  return {
    kind: "value",
    key,
    valueType,
    draft: existing ?? defaultValueFor(valueType, todayLocalDate()),
  };
}

function ValueInput({
  entryKey,
  type,
  value,
  allowed,
  readonly,
  onChange,
  onCommit,
  onCreatePage,
  onPageCreated,
}: {
  entryKey: string;
  type: PropertyValueType;
  value: PropertyValue;
  allowed: string[];
  readonly: boolean;
  onChange: (value: PropertyValue) => void;
  onCommit: (value: PropertyValue) => void;
  onCreatePage: (id: string) => Command | Command[];
  onPageCreated: () => void;
}) {
  const { message } = useI18n();
  const label = message("properties.value", { key: propertyDisplayName(entryKey, message) });
  if (type === "page") {
    if (readonly) return <Input aria-label={label} value={String(value.value)} readOnly />;
    return (
      <PageAutocomplete
        autoFocus
        placeholder={message("properties.pickPage")}
        allowCreate
        onPick={(id) => onCommit({ type: "page", value: id })}
        onCreate={onCreatePage}
        onCreated={onPageCreated}
      />
    );
  }
  if (allowed.length > 0) {
    // A stored value outside the offered set stays listed — opening the editor
    // can never silently rewrite it.
    const current = value.type === "string" ? value.value : "";
    const options = !current || allowed.includes(current) ? allowed : [current, ...allowed];
    const glyphFor = (option: string) =>
      entryKey === TASK_STATUS_KEY ? (
        <TaskStatusGlyph status={option} />
      ) : entryKey === TASK_PRIORITY_KEY ? (
        <PriorityGlyph priority={option} />
      ) : null;
    const labelFor = (option: string) =>
      entryKey === TASK_STATUS_KEY
        ? statusLabel(option, message)
        : entryKey === TASK_PRIORITY_KEY
          ? priorityLabel(option, message)
          : option;
    return (
      <ListBox className="property-picker-list" aria-label={label}>
        {options.map((option) => (
          <ListBoxItem
            id={option}
            textValue={labelFor(option)}
            key={option}
            aria-selected={value.type === "string" && value.value === option}
            className="property-picker-option"
            isDisabled={readonly}
            onAction={() => onCommit({ type: "string", value: option })}
          >
            {glyphFor(option)}
            <span className="property-picker-candidate">
              <span>{labelFor(option)}</span>
            </span>
            {value.type === "string" && value.value === option && (
              <CheckIcon data-icon aria-hidden />
            )}
          </ListBoxItem>
        ))}
      </ListBox>
    );
  }
  if (type === "checkbox") {
    return (
      <ListBox className="property-picker-list" aria-label={label}>
        {[true, false].map((checked) => (
          <ListBoxItem
            id={String(checked)}
            textValue={checked ? message("properties.checked") : message("properties.unchecked")}
            key={String(checked)}
            aria-selected={value.type === "checkbox" && value.value === checked}
            className="property-picker-option"
            isDisabled={readonly}
            onAction={() => onCommit({ type: "checkbox", value: checked })}
          >
            {checked ? message("properties.checked") : message("properties.unchecked")}
          </ListBoxItem>
        ))}
      </ListBox>
    );
  }
  if (entryKey === TASK_REPEAT_KEY) {
    return <RepeatValueInput value={value} readonly={readonly} onCommit={onCommit} />;
  }
  if (type === "date") {
    return (
      <DateValueInput
        label={label}
        value={value}
        readonly={readonly}
        onChange={onChange}
        onCommit={onCommit}
      />
    );
  }
  return (
    <Input
      autoFocus
      type={type === "number" ? "number" : "text"}
      aria-label={label}
      value={String(value.value)}
      readOnly={readonly}
      onChange={(event) => {
        const next = event.target.value;
        onChange(
          type === "number"
            ? { type: "number", value: Number(next) }
            : { type: "string", value: next },
        );
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) onCommit(value);
      }}
    />
  );
}

/**
 * Dates commit the way the palette navigates to them: the same words. The text
 * field accepts natural language ("tomorrow", "aug 15", "다음 월요일") and
 * shows the day it resolved to as a pressable row; quick rows cover the three
 * most common answers, and a native date input stays at the bottom because the
 * platform's own picker is the better precision tool
 * (designs/interaction.md § Choice).
 */
function DateValueInput({
  label,
  value,
  readonly,
  onChange,
  onCommit,
}: {
  label: string;
  value: PropertyValue;
  readonly: boolean;
  onChange: (value: PropertyValue) => void;
  onCommit: (value: PropertyValue) => void;
}) {
  const { message, temporal, formatJournalDate } = useI18n();
  const [text, setText] = useState("");
  const today = todayLocalDate();
  const parsedResult = text.trim()
    ? temporal.parseDate(text, { today })
    : { kind: "none" as const };
  const parsed = parsedResult.kind === "match" ? parsedResult.value : null;
  const commitDate = (date: string) => onCommit({ type: "date", value: date });
  const quick: { id: string; label: string; date: string }[] = [
    { id: "today", label: message("properties.today"), date: today },
    { id: "tomorrow", label: message("properties.tomorrow"), date: addDays(today, 1) },
    { id: "next-week", label: message("properties.nextWeek"), date: addDays(today, 7) },
  ];
  const rows = text.trim()
    ? parsed
      ? [
          {
            id: "parsed",
            date: parsed,
            label: message("properties.dateOn", { date: formatJournalDate(parsed) }),
          },
        ]
      : []
    : quick;

  return (
    <div className="property-date-editor">
      <Autocomplete inputValue={text} onInputChange={setText}>
        <SearchField aria-label={message("properties.dateText")} isReadOnly={readonly}>
          <AriaInput
            render={(props) => <Input {...props} />}
            autoFocus
            placeholder={message("properties.datePlaceholder")}
          />
        </SearchField>
        <ListBox
          className="property-picker-list"
          aria-label={label}
          items={rows}
          disabledKeys={readonly ? rows.map((row) => row.id) : []}
          onAction={(id) => {
            const row = rows.find((row) => row.id === id);
            if (row) commitDate(row.date);
          }}
          renderEmptyState={() => <p className="ac-hint">{message("properties.noKeys")}</p>}
        >
          {(option) => (
            <ListBoxItem
              id={option.id}
              textValue={option.label}
              className="property-picker-option"
              data-testid={option.id === "parsed" ? "date-parsed" : undefined}
            >
              <CalendarIcon data-type-glyph aria-hidden />
              <span className="property-picker-candidate">
                <span>{option.label}</span>
                <small>
                  {option.id === "parsed" ? option.date : formatJournalDate(option.date)}
                </small>
              </span>
            </ListBoxItem>
          )}
        </ListBox>
      </Autocomplete>
      <div className="property-date-native">
        <Input
          type="date"
          aria-label={message("properties.pickDate")}
          value={value.type === "date" ? value.value : ""}
          readOnly={readonly}
          onChange={(event) => {
            const next = event.target.value;
            if (!next) return;
            onChange({ type: "date", value: next });
            onCommit({ type: "date", value: next });
          }}
        />
      </div>
    </div>
  );
}

/**
 * The recurrence interval: a count and a unit, which is the whole grammar this
 * product's repeats have. It is deliberately not a cron field or an RRULE — a
 * task that repeats every N days, weeks, months or years covers what an outliner
 * is asked for, and anything past that is a calendar's job.
 */
function RepeatValueInput({
  value,
  readonly,
  onCommit,
}: {
  value: PropertyValue;
  readonly: boolean;
  onCommit: (value: PropertyValue) => void;
}) {
  const { message } = useI18n();
  const stored = value.type === "string" ? parseRepeat(value.value) : null;
  const [interval, setInterval] = useState(stored ?? DEFAULT_REPEAT);
  const commit = (next: typeof interval) => onCommit({ type: "string", value: formatRepeat(next) });

  return (
    <div className="property-repeat-editor">
      <Input
        autoFocus
        type="number"
        min={1}
        max={999}
        inputMode="numeric"
        aria-label={message("task.repeatCount")}
        data-testid="repeat-count"
        value={String(interval.count)}
        readOnly={readonly}
        onChange={(event) => {
          const count = Number(event.target.value);
          if (Number.isInteger(count) && count >= 1 && count <= 999) {
            setInterval({ ...interval, count });
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) commit(interval);
        }}
      />
      <MenuSelect
        label={message("task.repeatUnitLabel")}
        testId="repeat-unit"
        value={interval.unit}
        options={REPEAT_UNITS.map((unit) => ({
          value: unit,
          label: repeatUnitLabel(unit, message),
        }))}
        onValueChange={(next) => setInterval({ ...interval, unit: next as RepeatUnit })}
      />
      <Button disabled={readonly} data-testid="repeat-set" onClick={() => commit(interval)}>
        {message("properties.set")}
      </Button>
      {/* The interval in words, so the choice is confirmed by reading it rather
          than by decoding a count and a unit noun in two separate controls. */}
      <p className="property-repeat-preview">{repeatLabel(interval, message)}</p>
    </div>
  );
}

/** The single string a key holds, for reading a refinement out of the same bag. */
function singleString(bag: PropertyField[], key: string): string | undefined {
  const value = bag.find((field) => field.key === key)?.values[0];
  return value?.type === "string" ? value.value : undefined;
}
