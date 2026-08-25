import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { ArrowLeftIcon, CalendarIcon, CheckIcon, ClockIcon, Trash2Icon } from "lucide-react";
import type { Command, PropertyOwnerRef } from "../../core-port/commands";
import type {
  OutlineOwner,
  PropertyField,
  PropertyValue,
  PropertyValueType,
} from "../../core-port/snapshot";
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
import { addDays, todayLocalDate } from "../../entities/journal";
import {
  DEFAULT_REPEAT,
  formatRepeat,
  isTaskDateKey,
  isTimeOfDay,
  offeredChoices,
  parseRepeat,
  REPEAT_UNITS,
  TASK_PRIORITY_KEY,
  TASK_REPEAT_KEY,
  TASK_STATUS_KEY,
  timeKeyFor,
  type RepeatUnit,
} from "../../entities/tasks";
import { useAnchoredPosition, type Anchor } from "@/ui/anchored";
import { useOverlayRoot } from "@/ui/overlay-root";
import { Button } from "@/ui/shadcn/button";
import { Input } from "@/ui/shadcn/input";
import { moveOptionFocus } from "@/ui/listbox";
import { MenuSelect } from "@/ui/menu-select";
import { useI18n } from "../../i18n";
import type { AsyncRequestState } from "../../lib/async";
import { parseDateQuery } from "../commands/dates";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { PriorityGlyph, TaskStatusGlyph } from "../tasks/glyphs";
import { priorityLabel, repeatLabel, repeatUnitLabel, statusLabel } from "../tasks/labels";
import { PageAutocomplete } from "./PageAutocomplete";
import {
  propertyDisplayName,
  propertyGlyph,
  storageKeyForQuery,
  TypeGlyph,
} from "./property-display";
import { validationMessage } from "./property-validation";

export type PropertyTarget =
  | { kind: "page"; id: string; bag: PropertyField[] }
  | { kind: "block"; id: string; owner: OutlineOwner; bag: PropertyField[] }
  // A tag's *defaults*: the values copied onto a block when the tag is added.
  // Same picker, stages, and owner-based property commands.
  | { kind: "tag"; id: string; bag: PropertyField[] };

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
  onClose,
}: {
  target: PropertyTarget;
  anchor: Anchor;
  initialKey?: string;
  onClose: () => void;
}) {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const { message, compare } = useI18n();
  const readonly = state.mode === "readonly";
  const initial = initialKey?.trim() || null;
  const [stage, setStage] = useState<PickerStage>(() => initialStage(initial, target.bag));
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [request, setRequest] = useState<AsyncRequestState>({ status: "idle" });
  const committing = request.status === "busy";
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const key = stage.kind === "property" ? null : stage.key;

  const owner: PropertyOwnerRef = target.kind === "page"
    ? { kind: "page", id: target.id }
    : target.kind === "block"
      ? { kind: "block", owner: target.owner, id: target.id }
      : { kind: "tag_default", tag_id: target.id };
  // Placement checks speak the registry's language: a tag target writes the
  // `tag_default` placement, never a bag of its own.
  const writeTarget = target.kind === "tag" ? "tag_default" : target.kind;
  const selectedUnsupported = key !== null && target.bag
    .find((field) => field.key === key)
    ?.values.some((value) => value.type === "unsupported_document");
  const writeDisabled = readonly
    || selectedUnsupported
    || (key !== null && !canUserWrite(key, writeTarget));

  // A stage change resizes the panel, so it re-places on the way through.
  const position = useAnchoredPosition(
    anchor,
    { width: 360, minWidth: 280, maxHeight: 420 },
    stage.kind,
  );
  const overlayRoot = useOverlayRoot();
  const resetStage = useCallback(() => {
    setStage({ kind: "property" });
    setRequest({ status: "idle" });
  }, []);

  useEffect(() => {
    const closeOnOutsidePress = (event: PointerEvent) => {
      const node = event.target;
      if (
        node instanceof Node &&
        !panelRef.current?.contains(node) &&
        // A surface this panel opened is not "outside" it. Both the entity
        // autocomplete and the one dropdown (designs/interaction.md § Choice) portal to the body, so a
        // press on one of their rows lands outside `panelRef` in the DOM while
        // being, to the user, a press inside the editor they are filling in.
        // Without this, choosing from a nested menu dismissed the picker before
        // the choice could reach it.
        !(node instanceof Element
          && node.closest('.ac-popover, [data-slot="dropdown-menu-content"]'))
      ) onClose();
    };
    // Radix selects context-menu rows during the same pointer gesture that
    // mounts this portal. Arm outside dismissal on the next task so that
    // invocation gesture cannot also dismiss what it just opened.
    const timer = window.setTimeout(() => {
      window.addEventListener("pointerdown", closeOnOutsidePress, true);
    }, 0);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", closeOnOutsidePress, true);
    };
  }, [onClose]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (stage.kind === "property") {
        // Context-menu primitives restore focus after their item has mounted
        // this portal. Reassert the dialog's initial focus afterward.
        searchRef.current?.focus({ preventScroll: true });
        return;
      }
      if (panelRef.current?.contains(document.activeElement)) return;
      // Choice-only value editors (checkboxes and enums) have no autofocus
      // input. Keep keyboard focus inside the dialog so Escape and Tab remain
      // available after moving between stages.
      panelRef.current?.querySelector<HTMLElement>(
        '.property-picker-list [role="option"]:not([disabled]), .property-picker-value input:not([disabled]), .property-picker-value button:not([disabled])',
      )?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [stage.kind]);

  useEffect(() => {
    const handleDetachedEscape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.isComposing ||
        event.keyCode === 229 ||
        (event.target instanceof Node && panelRef.current?.contains(event.target))
      ) return;
      event.preventDefault();
      if (stage.kind === "property") onClose();
      else resetStage();
    };
    window.addEventListener("keydown", handleDetachedEscape);
    return () => window.removeEventListener("keydown", handleDetachedEscape);
  }, [onClose, resetStage, stage.kind]);

  const visibleEntries = useMemo(
    () => target.bag.filter((entry) => isGenericProperty(entry.key)),
    [target.bag],
  );
  const candidates = useMemo<Candidate[]>(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const present = new Set(visibleEntries.map((entry) => entry.key));
    const known = Object.keys(REGISTRY)
      .filter((key) => isGenericProperty(key) && canUserWrite(key, writeTarget));
    // A query reaches a key through its storage name OR the name it goes by on
    // screen, so "예정" finds builtin.task-scheduled and "effort" finds
    // user.effort alike.
    const keys = [...new Set([...visibleEntries.map((entry) => entry.key), ...known])]
      .filter((item) =>
        !normalized ||
        item.toLocaleLowerCase().includes(normalized) ||
        propertyDisplayName(item, message).toLocaleLowerCase().includes(normalized))
      .sort((left, right) => {
        const existing = Number(present.has(right)) - Number(present.has(left));
        return existing
          || compare(propertyDisplayName(left, message), propertyDisplayName(right, message));
      });
    const result = keys.map((item) => ({ key: item, existing: present.has(item), create: false }));
    // A bare name is a user property waiting to exist: typing `effort` offers
    // to create `user.effort`. The prefix is storage routing, not something the
    // user should have to type or read.
    const storageKey = storageKeyForQuery(query);
    const exact = keys.some((item) => item === storageKey);
    if (normalized && !exact && !validateKey(storageKey) && !validateWriteTarget(storageKey, writeTarget)) {
      result.push({ key: storageKey, existing: false, create: true });
    }
    return result.slice(0, 12);
  }, [compare, message, query, writeTarget, visibleEntries]);

  useEffect(() => setActive(0), [query, stage.kind]);

  const run = async (command: Command): Promise<boolean> => {
    setRequest({ status: "busy" });
    try {
      await session.execute(command);
      setRequest({ status: "idle" });
      return true;
    } catch (cause) {
      notify.failure(message("failure.setProperty"), cause);
      setRequest({ status: "failed", message: message("failure.setProperty") });
      return false;
    }
  };

  const chooseKey = (candidate: Candidate) => {
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
    const cardinality = existing?.cardinality === "set" ? "repeated" : cardinalityOf(key);
    const issue = keyIssue
      ?? validateWriteTarget(key, writeTarget)
      ?? validateValue(key, value, cardinality);
    if (issue) {
      setRequest({ status: "failed", message: validationMessage(issue, message) });
      return;
    }
    const repeated = cardinality === "repeated";
    const saved = await run(repeated
      ? { type: "add_repeated_property", owner, key, value }
      : { type: "set_property", owner, key, value });
    if (!saved) return;
    onClose();
  };

  const ensureEmpty = async () => {
    if (stage.kind !== "value" || writeDisabled) return;
    const { key, valueType } = stage;
    const cardinality = cardinalityOf(key) === "repeated" ? "set" : "single";
    const saved = await run({
      type: "ensure_property",
      owner,
      key,
      value_type: valueType,
      cardinality,
    });
    if (saved) onClose();
  };

  const removeValue = async (value: PropertyValue) => {
    if (stage.kind !== "value" || writeDisabled) return;
    const { key } = stage;
    const removed = await run({ type: "remove_repeated_property", owner, key, value });
    if (removed) onClose();
  };

  const clearValues = async () => {
    if (stage.kind !== "value" || writeDisabled) return;
    const { key } = stage;
    const cleared = await run({ type: "clear_property_values", owner, key });
    if (cleared) onClose();
  };

  const removeField = async () => {
    if (stage.kind !== "value" || writeDisabled) return;
    const { key } = stage;
    const removed = await run({ type: "remove_property", owner, key });
    if (removed) onClose();
  };

  /**
   * A refinement of the value being edited, written without closing: the time of
   * day beside a task date, or its repeat interval. These are separate keys
   * because they are separate facts, so each is still exactly one command — but
   * they are not the *answer* the picker was opened for, and closing on one of
   * them would throw the user out halfway through describing one moment.
   */
  const writeRefinement = (refinementKey: string, value: PropertyValue | null) => {
    if (readonly || !canUserWrite(refinementKey, writeTarget)) return;
    void run(value === null
      ? { type: "remove_property", owner, key: refinementKey }
      : { type: "set_property", owner, key: refinementKey, value });
  };

  const onKeyList = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((index) => Math.min(index + 1, candidates.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      if (candidates[active]) chooseKey(candidates[active]);
    } else if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    }
  };

  const selectedField = key ? visibleEntries.find((field) => field.key === key) : undefined;
  const selectedValues = selectedField?.values ?? [];
  const choices = key ? offeredChoices(key, stringChoicesOf(key)) : [];
  const selectedCardinality = key === null
    ? "single"
    : selectedField?.cardinality ?? (cardinalityOf(key) === "repeated" ? "set" : "single");
  // Report a bad key only when it is a dead end — while matches are still on
  // screen the query is a search, not a mistake.
  const queryIssue = stage.kind === "property" && query.trim() && candidates.length === 0
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
    if (value.type === "checkbox") return value.value
      ? message("properties.checked")
      : message("properties.unchecked");
    if (value.type === "page") {
      const page = findPage(state.snapshot, value.value);
      if (!page) return value.value;
      return isDeleted(page)
        ? message("properties.deleted", { name: pageTitle(page) })
        : pageTitle(page);
    }
    return String(value.value);
  };
  const describeField = (field: PropertyField): string => field.values.length === 0
    ? message("properties.noValue")
    : field.values.map(describeValue).join(", ");

  return createPortal(
    <div
      ref={panelRef}
      className="property-picker"
      style={position}
      role="dialog"
      aria-label={message("properties.addOrChange")}
      data-testid="property-picker"
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          event.stopPropagation();
          if (stage.kind === "property") onClose();
          else resetStage();
          return;
        }
        if (event.key === "Tab") {
          const focusable = panelRef.current?.querySelectorAll<HTMLElement>(
            'input:not([disabled]),button:not([disabled]):not([tabindex="-1"])',
          );
          if (!focusable || focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }
      }}
    >
      <div className="property-picker-head">
        {stage.kind !== "property" && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={message("properties.back")}
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
          {stage.kind === "value" && (
            <span>{message(`properties.type.${stage.valueType}`)}</span>
          )}
        </div>
      </div>

      {stage.kind === "property" && (
        <>
          <Input
            ref={searchRef}
            autoFocus
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={candidates[active] ? `${listId}-${active}` : undefined}
            aria-label={message("properties.propertyKey")}
            placeholder={message("properties.propertyKey")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyList}
          />
          <div id={listId} role="listbox" className="property-picker-list">
            {candidates.length === 0 && <p className="ac-hint">{message("properties.noKeys")}</p>}
            {candidates.map((candidate, index) => (
              <button
                id={`${listId}-${index}`}
                key={candidate.key}
                role="option"
                aria-selected={index === active}
                data-active={index === active}
                className="property-picker-option"
                tabIndex={-1}
                onPointerMove={() => setActive(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => chooseKey(candidate)}
                title={candidate.key}
              >
                {candidate.create
                  ? <TypeGlyph type={undefined} />
                  : propertyGlyph(
                      candidate.key,
                      valueTypeOf(candidate.key)
                        ?? target.bag.find((field) => field.key === candidate.key)?.value_type,
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
                    <small>{describeField(visibleEntries.find((field) => field.key === candidate.key)!)}</small>
                  )}
                </span>
                {candidate.existing && <CheckIcon data-icon aria-hidden />}
              </button>
            ))}
          </div>
          {queryIssue && (
            <p className="field-error" role="alert" data-testid="props-error">
              {validationMessage(queryIssue, message)}
            </p>
          )}
        </>
      )}

      {stage.kind === "type" && (
        <div
          className="property-picker-list"
          role="listbox"
          aria-label={message("properties.newType")}
          onKeyDown={(event) => {
            if (moveOptionFocus(event.currentTarget, event.key)) event.preventDefault();
          }}
        >
          {VALUE_TYPES.map((valueType) => (
            <button
              key={valueType}
              role="option"
              aria-selected={false}
              className="property-picker-option"
              disabled={readonly}
              onPointerMove={(event) => event.currentTarget.focus({ preventScroll: true })}
              onClick={() => chooseType(valueType)}
            >
              <TypeGlyph type={valueType} />
              <span className="property-picker-candidate">
                <span>{message(`properties.type.${valueType}`)}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {stage.kind === "value" && (
        <div className="property-picker-value">
          {selectedCardinality === "set" && selectedValues.length > 0 && (
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
          {selectedCardinality === "single" && selectedValues[0] && (
            <p className="property-current-value">{describeValue(selectedValues[0])}</p>
          )}
          {selectedField && selectedValues.length === 0 && (
            <p className="property-current-value">{message("properties.noValue")}</p>
          )}
          <ValueInput
            entryKey={stage.key}
            type={stage.valueType}
            value={stage.draft}
            allowed={choices}
            bag={target.bag}
            readonly={writeDisabled || committing}
            onChange={(draft) => {
              setStage((current) =>
                current.kind === "value" ? { ...current, draft } : current);
            }}
            onCommit={(value) => void commit(value)}
            onRefine={writeRefinement}
          />
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
            {stage.valueType !== "page"
              && stage.valueType !== "date"
              && stage.key !== TASK_REPEAT_KEY
              && choices.length === 0 && (
              <Button
                onClick={() => void commit(stage.draft)}
                disabled={writeDisabled || committing}
                data-testid="property-set"
              >
                {message("properties.set")}
              </Button>
            )}
          </div>
        </div>
      )}

      {request.status === "failed" && (
        <p className="field-error" role="alert" data-testid="props-error">
          {request.message}
        </p>
      )}
    </div>,
    overlayRoot,
  );
}

function initialStage(key: string | null, bag: PropertyField[]): PickerStage {
  if (!key) return { kind: "property" };
  const existing = bag.find((field) => field.key === key)?.values[0];
  const valueType = valueTypeOf(key)
    ?? bag.find((field) => field.key === key)?.value_type
    ?? "string";
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
  bag,
  readonly,
  onChange,
  onCommit,
  onRefine,
}: {
  entryKey: string;
  type: PropertyValueType;
  value: PropertyValue;
  allowed: string[];
  bag: PropertyField[];
  readonly: boolean;
  onChange: (value: PropertyValue) => void;
  onCommit: (value: PropertyValue) => void;
  onRefine: (key: string, value: PropertyValue | null) => void;
}) {
  const { message } = useI18n();
  const label = message("properties.value", { key: propertyDisplayName(entryKey, message) });
  const listNav = (event: KeyboardEvent<HTMLDivElement>) => {
    if (moveOptionFocus(event.currentTarget, event.key)) event.preventDefault();
  };
  const hoverFocus = (event: { currentTarget: HTMLElement }) =>
    event.currentTarget.focus({ preventScroll: true });

  if (type === "page") {
    if (readonly) return <Input aria-label={label} value={String(value.value)} readOnly />;
    return (
      <PageAutocomplete
        autoFocus
        placeholder={message("properties.pickPage")}
        allowCreate
        onPick={(id) => onCommit({ type: "page", value: id })}
      />
    );
  }
  if (allowed.length > 0) {
    // A stored value outside the offered set stays listed — opening the editor
    // can never silently rewrite it.
    const current = value.type === "string" ? value.value : "";
    const options = !current || allowed.includes(current) ? allowed : [current, ...allowed];
    const glyphFor = (option: string) =>
      entryKey === TASK_STATUS_KEY
        ? <TaskStatusGlyph status={option} />
        : entryKey === TASK_PRIORITY_KEY
          ? <PriorityGlyph priority={option} />
          : null;
    const labelFor = (option: string) =>
      entryKey === TASK_STATUS_KEY
        ? statusLabel(option, message)
        : entryKey === TASK_PRIORITY_KEY
          ? priorityLabel(option, message)
          : option;
    return (
      <div className="property-picker-list" role="listbox" aria-label={label} onKeyDown={listNav}>
        {options.map((option) => (
          <button
            key={option}
            role="option"
            aria-selected={value.type === "string" && value.value === option}
            className="property-picker-option"
            disabled={readonly}
            onPointerMove={hoverFocus}
            onClick={() => onCommit({ type: "string", value: option })}
          >
            {glyphFor(option)}
            <span className="property-picker-candidate">
              <span>{labelFor(option)}</span>
            </span>
            {value.type === "string" && value.value === option && <CheckIcon data-icon aria-hidden />}
          </button>
        ))}
      </div>
    );
  }
  if (type === "checkbox") {
    return (
      <div className="property-picker-list" role="listbox" aria-label={label} onKeyDown={listNav}>
        {[true, false].map((checked) => (
          <button
            key={String(checked)}
            role="option"
            aria-selected={value.type === "checkbox" && value.value === checked}
            className="property-picker-option"
            disabled={readonly}
            onPointerMove={hoverFocus}
            onClick={() => onCommit({ type: "checkbox", value: checked })}
          >
            {checked ? message("properties.checked") : message("properties.unchecked")}
          </button>
        ))}
      </div>
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
        // A task moment is a day *and* a time of day, and the two are read as one
        // fact. The generic date editor keeps its shape; the task keys grow one
        // extra row rather than a second surface to visit.
        refinements={isTaskDateKey(entryKey)
          ? {
              timeKey: timeKeyFor(entryKey),
              time: singleString(bag, timeKeyFor(entryKey)),
              onRefine,
            }
          : undefined}
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
        onChange(type === "number"
          ? { type: "number", value: Number(next) }
          : { type: "string", value: next });
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
interface DateRefinements {
  timeKey: string;
  time: string | undefined;
  onRefine: (key: string, value: PropertyValue | null) => void;
}

function DateValueInput({
  label,
  value,
  readonly,
  onChange,
  onCommit,
  refinements,
}: {
  label: string;
  value: PropertyValue;
  readonly: boolean;
  onChange: (value: PropertyValue) => void;
  onCommit: (value: PropertyValue) => void;
  refinements?: DateRefinements;
}) {
  const { message, locale, formatJournalDate } = useI18n();
  const [text, setText] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const today = todayLocalDate();
  const parsed = text.trim() ? parseDateQuery(text, today, locale) : null;
  const commitDate = (date: string) => onCommit({ type: "date", value: date });
  const quick: { id: string; label: string; date: string }[] = [
    { id: "today", label: message("properties.today"), date: today },
    { id: "tomorrow", label: message("properties.tomorrow"), date: addDays(today, 1) },
    { id: "next-week", label: message("properties.nextWeek"), date: addDays(today, 7) },
  ];
  // What the keyboard walks: the parsed day while there is text, else the
  // quick answers. Same combobox contract as the property search above it.
  const rows: { id: string; date: string }[] = text.trim().length > 0
    ? (parsed ? [{ id: "parsed", date: parsed }] : [])
    : quick.map(({ id, date }) => ({ id, date }));
  const activeRow = Math.min(active, Math.max(rows.length - 1, 0));

  return (
    <div className="property-date-editor">
      <Input
        autoFocus
        role="combobox"
        aria-expanded={rows.length > 0}
        aria-controls={listId}
        aria-activedescendant={rows[activeRow] ? `${listId}-${rows[activeRow].id}` : undefined}
        aria-label={message("properties.dateText")}
        placeholder={message("properties.datePlaceholder")}
        value={text}
        readOnly={readonly}
        onChange={(event) => {
          setText(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "ArrowDown") {
            event.preventDefault();
            setActive((index) => Math.min(index + 1, Math.max(rows.length - 1, 0)));
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            setActive((index) => Math.max(index - 1, 0));
          } else if (event.key === "Enter") {
            event.preventDefault();
            const row = rows[activeRow];
            if (row) commitDate(row.date);
          }
        }}
      />
      <div id={listId} className="property-picker-list" role="listbox" aria-label={label}>
        {text.trim().length > 0
          ? parsed
            ? (
                <button
                  id={`${listId}-parsed`}
                  role="option"
                  aria-selected
                  className="property-picker-option"
                  data-active="true"
                  data-testid="date-parsed"
                  disabled={readonly}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => commitDate(parsed)}
                >
                  <CalendarIcon data-type-glyph aria-hidden />
                  <span className="property-picker-candidate">
                    <span>{message("properties.dateOn", { date: formatJournalDate(parsed) })}</span>
                    <small>{parsed}</small>
                  </span>
                </button>
              )
            : <p className="ac-hint">{message("properties.noKeys")}</p>
          : quick.map((option, index) => (
              <button
                id={`${listId}-${option.id}`}
                key={option.id}
                role="option"
                aria-selected={value.type === "date" && value.value === option.date}
                data-active={index === activeRow}
                className="property-picker-option"
                disabled={readonly}
                onPointerMove={() => setActive(index)}
                onPointerDown={(event) => event.preventDefault()}
                onClick={() => commitDate(option.date)}
              >
                <CalendarIcon data-type-glyph aria-hidden />
                <span className="property-picker-candidate">
                  <span>{option.label}</span>
                  <small>{formatJournalDate(option.date)}</small>
                </span>
              </button>
            ))}
      </div>
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
      {refinements && <TimeOfDayRow readonly={readonly} {...refinements} />}
    </div>
  );
}

/**
 * The time of day beside a task date. It is the platform's own time input for the
 * same reason the date row keeps a native picker — a clock is one of the few
 * controls a browser genuinely does better — and it writes as soon as it is
 * complete, because a time is a refinement rather than the answer the picker was
 * opened for. Clearing it returns the moment to the whole day, which is what a
 * date with no time has always meant.
 */
function TimeOfDayRow({
  timeKey,
  time,
  readonly,
  onRefine,
}: DateRefinements & { readonly: boolean }) {
  const { message } = useI18n();
  const current = time !== undefined && isTimeOfDay(time) ? time : "";
  return (
    <div className="property-date-time">
      <ClockIcon data-type-glyph aria-hidden />
      <Input
        type="time"
        aria-label={message("task.timeOfDay")}
        data-testid="task-time"
        value={current}
        readOnly={readonly}
        onChange={(event) => {
          const next = event.target.value;
          // A partially typed time is not a value yet; an emptied field is.
          if (next === "") onRefine(timeKey, null);
          else if (isTimeOfDay(next)) onRefine(timeKey, { type: "string", value: next });
        }}
      />
      {current !== "" && (
        <Button
          variant="ghost"
          size="icon"
          disabled={readonly}
          aria-label={message("task.clearTime")}
          data-testid="task-time-clear"
          onClick={() => onRefine(timeKey, null)}
        >
          <Trash2Icon data-icon aria-hidden />
        </Button>
      )}
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
  const commit = (next: typeof interval) =>
    onCommit({ type: "string", value: formatRepeat(next) });

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
      <Button
        disabled={readonly}
        data-testid="repeat-set"
        onClick={() => commit(interval)}
      >
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
