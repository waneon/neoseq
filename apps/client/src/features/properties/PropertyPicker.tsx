import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { ArrowLeftIcon, CheckIcon, Trash2Icon } from "lucide-react";
import type { Command, EntityRef } from "../../core-port/commands";
import type { PropertyEntry, PropertyValue, PropertyValueType } from "../../core-port/snapshot";
import { findPage, isDeleted, pageTitle } from "../../core-port/snapshot";
import {
  cardinalityOf,
  defaultValueFor,
  definition,
  formatValue,
  isGenericProperty,
  REGISTRY,
  validateKey,
  validateValue,
  validateWriteTarget,
  VALUE_TYPES,
} from "../../entities/properties";
import { todayLocalDate } from "../../entities/journal";
import { Button } from "@/ui/shadcn/button";
import { Input } from "@/ui/shadcn/input";
import { useI18n } from "../../i18n";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { PageAutocomplete } from "./PageAutocomplete";
import { validationMessage } from "./property-validation";

export type PropertyTarget =
  | { kind: "page"; id: string; bag: PropertyEntry[] }
  | { kind: "block"; id: string; pageId: string; bag: PropertyEntry[] };

type Stage = "property" | "type" | "value";

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
  anchor: HTMLElement | null;
  initialKey?: string;
  onClose: () => void;
}) {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const { message, compare } = useI18n();
  const readonly = state.mode === "readonly";
  const initial = initialKey?.trim() || null;
  const [stage, setStage] = useState<Stage>(initial ? "value" : "property");
  const [query, setQuery] = useState("");
  const [key, setKey] = useState<string | null>(initial);
  const [type, setType] = useState<PropertyValueType>(() => {
    if (!initial) return "string";
    return definition(initial)?.type ?? target.bag.find((entry) => entry.key === initial)?.value.type ?? "string";
  });
  const [draft, setDraft] = useState<PropertyValue>(() => initialValue(initial, target.bag));
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [committing, setCommitting] = useState(false);
  const [position, setPosition] = useState({ left: 24, top: 96, width: 360 });
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const entity: EntityRef = target.kind === "page"
    ? { kind: "page", id: target.id }
    : { kind: "block", page_id: target.pageId, id: target.id };

  const reposition = useCallback(() => {
    const rect = anchor?.getBoundingClientRect();
    const width = Math.min(360, Math.max(280, window.innerWidth - 24));
    const desiredLeft = rect?.left ?? (window.innerWidth - width) / 2;
    const left = Math.max(12, Math.min(desiredLeft, window.innerWidth - width - 12));
    const below = (rect?.bottom ?? 72) + 6;
    const top = Math.max(12, Math.min(below, window.innerHeight - 420));
    setPosition({ left, top, width });
  }, [anchor]);

  useLayoutEffect(() => {
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [reposition, stage]);

  useEffect(() => {
    const closeOnOutsidePress = (event: PointerEvent) => {
      const node = event.target;
      if (
        node instanceof Node &&
        !panelRef.current?.contains(node) &&
        !(node instanceof Element && node.closest(".ac-popover"))
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
      if (stage === "property") {
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
  }, [stage]);

  useEffect(() => {
    const handleDetachedEscape = (event: globalThis.KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.isComposing ||
        event.keyCode === 229 ||
        (event.target instanceof Node && panelRef.current?.contains(event.target))
      ) return;
      event.preventDefault();
      if (stage === "property") onClose();
      else {
        setStage("property");
        setKey(null);
        setError(null);
      }
    };
    window.addEventListener("keydown", handleDetachedEscape);
    return () => window.removeEventListener("keydown", handleDetachedEscape);
  }, [onClose, stage]);

  const visibleEntries = useMemo(
    () => target.bag.filter((entry) => isGenericProperty(entry.key)),
    [target.bag],
  );
  const candidates = useMemo<Candidate[]>(() => {
    const normalized = query.trim().toLocaleLowerCase();
    const present = new Set(visibleEntries.map((entry) => entry.key));
    const known = REGISTRY
      .filter((item) => (
        isGenericProperty(item.key)
        && item.write_policy === "user"
        && item.user_writable_targets.includes(target.kind)
      ))
      .map((item) => item.key);
    const keys = [...new Set([...visibleEntries.map((entry) => entry.key), ...known])]
      .filter((item) => !normalized || item.toLocaleLowerCase().includes(normalized))
      .sort((left, right) => {
        const existing = Number(present.has(right)) - Number(present.has(left));
        return existing || compare(left, right);
      });
    const result = keys.map((item) => ({ key: item, existing: present.has(item), create: false }));
    const exact = keys.some((item) => item === query.trim());
    if (normalized && !exact && !validateKey(query.trim()) && !validateWriteTarget(query.trim(), target.kind)) {
      result.push({ key: query.trim(), existing: false, create: true });
    }
    return result.slice(0, 12);
  }, [compare, query, target.kind, visibleEntries]);

  useEffect(() => setActive(0), [query, stage]);

  const run = async (command: Command): Promise<boolean> => {
    setError(null);
    setCommitting(true);
    try {
      await session.execute(command);
      return true;
    } catch (cause) {
      notify.failure(message("failure.setProperty"), cause);
      setError(message("failure.setProperty"));
      return false;
    } finally {
      setCommitting(false);
    }
  };

  const chooseKey = (candidate: Candidate) => {
    const found = target.bag.find((entry) => entry.key === candidate.key);
    const known = definition(candidate.key);
    const nextType = known?.type ?? found?.value.type;
    setKey(candidate.key);
    setQuery("");
    if (!nextType) {
      setStage("type");
      return;
    }
    setType(nextType);
    setDraft(found?.value ?? defaultValueFor(nextType, todayLocalDate()));
    setStage("value");
  };

  const chooseType = (nextType: PropertyValueType) => {
    setType(nextType);
    setDraft(defaultValueFor(nextType, todayLocalDate()));
    setStage("value");
  };

  const commit = async (value: PropertyValue) => {
    if (!key || readonly) return;
    const keyIssue = validateKey(key);
    const issue = keyIssue
      ?? validateWriteTarget(key, target.kind)
      ?? validateValue(key, value, cardinalityOf(key));
    if (issue) {
      setError(validationMessage(issue, message));
      return;
    }
    const repeated = cardinalityOf(key) === "repeated";
    const saved = await run(repeated
      ? { type: "add_repeated_property", entity, key, value }
      : { type: "set_property", entity, key, value });
    if (!saved) return;
    if (key === "query.source" && !target.bag.some((entry) => entry.key === "query.language")) {
      const languageSaved = await run({
        type: "set_property",
        entity,
        key: "query.language",
        value: { type: "string", value: "sparql-1.1/neoseq-v1" },
      });
      if (!languageSaved) return;
    }
    onClose();
  };

  const remove = async (entry?: PropertyEntry) => {
    if (!key || readonly) return;
    if (!entry && cardinalityOf(key) === "repeated") {
      for (const member of selectedEntries) {
        const removed = await run({
          type: "remove_repeated_property",
          entity,
          key,
          value: member.value,
        });
        if (!removed) return;
      }
      onClose();
      return;
    }
    const removed = await run(entry
      ? { type: "remove_repeated_property", entity, key, value: entry.value }
      : { type: "remove_property", entity, key });
    if (removed) onClose();
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

  const selectedEntries = key ? visibleEntries.filter((entry) => entry.key === key) : [];
  const known = key ? definition(key) : undefined;
  const queryIssue = stage === "property" && query.trim()
    ? validateKey(query.trim())
    : null;
  const describeValue = (value: PropertyValue): string => {
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
          if (stage === "property") onClose();
          else {
            setStage("property");
            setKey(null);
            setError(null);
          }
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
        {stage !== "property" && (
          <Button
            variant="ghost"
            size="icon"
            aria-label={message("properties.back")}
            onClick={() => {
              setStage("property");
              setKey(null);
              setError(null);
            }}
          >
            <ArrowLeftIcon data-icon aria-hidden />
          </Button>
        )}
        <div>
          <strong>{stage === "property" ? message("properties.addOrChange") : key}</strong>
          {stage === "value" && (
            <span>{message(`properties.type.${type}`)}</span>
          )}
        </div>
      </div>

      {stage === "property" && (
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
              >
                <span className="property-picker-candidate">
                  <span className="mono">
                    {candidate.create
                      ? message("properties.createProperty", { key: candidate.key })
                      : candidate.key}
                  </span>
                  {candidate.existing && (
                    <small>{describeValue(visibleEntries.find((entry) => entry.key === candidate.key)!.value)}</small>
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

      {stage === "type" && (
        <div className="property-picker-list" role="listbox" aria-label={message("properties.newType")}>
          {VALUE_TYPES.map((valueType) => (
            <button
              key={valueType}
              role="option"
              aria-selected={false}
              className="property-picker-option"
              disabled={readonly}
              onClick={() => chooseType(valueType)}
            >
              {message(`properties.type.${valueType}`)}
            </button>
          ))}
        </div>
      )}

      {stage === "value" && key && (
        <div className="property-picker-value">
          {cardinalityOf(key) === "repeated" && selectedEntries.length > 0 && (
            <div className="property-picker-members">
              {selectedEntries.map((entry, index) => (
                <div key={`${entry.key}:${index}`}>
                  <span>{formatValue(entry.value)}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    disabled={committing}
                    aria-label={message("properties.removeValue", { key })}
                    onClick={() => void remove(entry)}
                  >
                    <Trash2Icon data-icon aria-hidden />
                  </Button>
                </div>
              ))}
            </div>
          )}
          {cardinalityOf(key) === "single" && selectedEntries[0] && (
            <p className="property-current-value">{describeValue(selectedEntries[0].value)}</p>
          )}
          <ValueInput
            entryKey={key}
            type={type}
            value={draft}
            allowed={known?.allowed_strings ?? []}
            readonly={readonly || committing}
            onChange={setDraft}
            onCommit={(value) => void commit(value)}
          />
          <div className="property-picker-actions">
            {selectedEntries.length > 0 && (
              <Button variant="destructive" onClick={() => void remove()} disabled={readonly || committing}>
                <Trash2Icon data-icon aria-hidden />
                {message("properties.clear")}
              </Button>
            )}
            {type !== "page" && (known?.allowed_strings.length ?? 0) === 0 && (
              <Button onClick={() => void commit(draft)} disabled={readonly || committing} data-testid="property-set">
                {message("properties.set")}
              </Button>
            )}
          </div>
        </div>
      )}

      {error && <p className="field-error" role="alert" data-testid="props-error">{error}</p>}
    </div>,
    document.body,
  );
}

function initialValue(key: string | null, bag: PropertyEntry[]): PropertyValue {
  if (!key) return { type: "string", value: "" };
  const existing = bag.find((entry) => entry.key === key)?.value;
  if (existing) return existing;
  return defaultValueFor(definition(key)?.type ?? "string", todayLocalDate());
}

function ValueInput({
  entryKey,
  type,
  value,
  allowed,
  readonly,
  onChange,
  onCommit,
}: {
  entryKey: string;
  type: PropertyValueType;
  value: PropertyValue;
  allowed: string[];
  readonly: boolean;
  onChange: (value: PropertyValue) => void;
  onCommit: (value: PropertyValue) => void;
}) {
  const { message } = useI18n();
  const label = message("properties.value", { key: entryKey });

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
    return (
      <div className="property-picker-list" role="listbox" aria-label={label}>
        {allowed.map((option) => (
          <button
            key={option}
            role="option"
            aria-selected={value.type === "string" && value.value === option}
            className="property-picker-option"
            disabled={readonly}
            onClick={() => onCommit({ type: "string", value: option })}
          >
            {option}
          </button>
        ))}
      </div>
    );
  }
  if (type === "checkbox") {
    return (
      <div className="property-picker-list" role="listbox" aria-label={label}>
        {[true, false].map((checked) => (
          <button
            key={String(checked)}
            role="option"
            aria-selected={value.type === "checkbox" && value.value === checked}
            className="property-picker-option"
            disabled={readonly}
            onClick={() => onCommit({ type: "checkbox", value: checked })}
          >
            {checked ? message("properties.checked") : message("properties.unchecked")}
          </button>
        ))}
      </div>
    );
  }
  const input = (
    <Input
      autoFocus
      type={type === "number" ? "number" : type === "date" ? "date" : "text"}
      aria-label={label}
      value={String(value.value)}
      readOnly={readonly}
      onChange={(event) => {
        const next = event.target.value;
        onChange(type === "number"
          ? { type: "number", value: Number(next) }
          : type === "date"
            ? { type: "date", value: next }
            : { type: "string", value: next });
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) onCommit(value);
      }}
    />
  );
  if (type !== "date") return input;
  return (
    <div className="property-date-input">
      {input}
      <Button
        variant="secondary"
        disabled={readonly}
        onClick={() => {
          const today = { type: "date", value: todayLocalDate() } as const;
          onChange(today);
          onCommit(today);
        }}
      >
        {message("properties.today")}
      </Button>
    </div>
  );
}
