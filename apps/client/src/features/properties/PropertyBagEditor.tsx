// One generic editor for node property bags. Well-known keys get richer inputs
// (allowed-string selects, date fields, page autocomplete) without hiding
// their uniform representation; unknown keys use the same path.

import { useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import type { Command, EntityRef } from "../../core-port/commands";
import type { PropertyEntry, PropertyValue, PropertyValueType } from "../../core-port/snapshot";
import { findPage, isDeleted, pageTitle } from "../../core-port/snapshot";
import {
  cardinalityOf,
  defaultValueFor,
  definition,
  isSystemKey,
  REGISTRY,
  sameValue,
  validateKey,
  validateValue,
  VALUE_TYPES,
  type ValidationIssue,
} from "../../entities/properties";
import { todayLocalDate } from "../../entities/journal";
import { Input } from "@/ui/shadcn/input";
import { NativeSelect } from "@/ui/shadcn/native-select";
import { Button } from "@/ui/shadcn/button";
import { cn } from "@/lib/utils";
import { useSession, useSessionState } from "../shell/session-context";
import { PageAutocomplete } from "./PageAutocomplete";
import { useI18n, type MessageFunction } from "../../i18n";
import { failureReason } from "../notify/errors";

export type BagKind = "block" | "page";

type PropertyBagEditorProps = {
  targetId: string;
  bag: PropertyEntry[];
  title: string;
  description?: string;
  /** False when an enclosing disclosure already names this bag. */
  showHeading?: boolean;
} & (
  | { kind: "block"; pageId: string }
  | { kind: "page"; pageId?: never }
);

export function PropertyBagEditor({
  kind,
  targetId,
  pageId,
  bag,
  title,
  description,
  showHeading = true,
}: PropertyBagEditorProps) {
  const session = useSession();
  const state = useSessionState();
  const readonly = state.mode === "readonly";
  const [error, setError] = useState<string | null>(null);
  const { message } = useI18n();

  const entity: EntityRef =
    kind === "block"
      ? { kind: "block", page_id: pageId, id: targetId }
      : { kind: "page", id: targetId };

  // System-owned keys are facts about the entity, not data on it: `page.kind`,
  // `journal.date` and `system.*`. They were rendered as read-only rows
  // with a dangling empty remove cell, which is exactly the noise this redesign
  // removes. They surface in the page-info dialog instead.
  const visible = bag.filter((entry) => !isSystemKey(entry.key));

  const run = async (command: Command) => {
    setError(null);
    try {
      await session.execute(command);
      return true;
    } catch (cause) {
      setError(failureReason(cause, message));
      return false;
    }
  };

  const validate = (key: string, value: PropertyValue): ValidationIssue | null =>
    validateValue(key, value, cardinalityOf(key));

  const commitValue = async (entry: PropertyEntry, next: PropertyValue) => {
    if (sameValue(entry.value, next)) return;
    const issue = validate(entry.key, next);
    if (issue) {
      setError(validationMessage(issue, message));
      return;
    }
    if (cardinalityOf(entry.key) === "repeated") {
      const added = await run({ type: "add_repeated_property", entity, key: entry.key, value: next });
      if (added) {
        await run({ type: "remove_repeated_property", entity, key: entry.key, value: entry.value });
      }
    } else {
      await run({ type: "set_property", entity, key: entry.key, value: next });
    }
  };

  const removeEntry = async (entry: PropertyEntry) => {
    if (cardinalityOf(entry.key) === "repeated") {
      await run({ type: "remove_repeated_property", entity, key: entry.key, value: entry.value });
    } else {
      await run({ type: "remove_property", entity, key: entry.key });
    }
  };

  const addEntry = async (key: string, value: PropertyValue, repeated: boolean) => {
    const keyIssue = validateKey(key);
    if (keyIssue) {
      setError(validationMessage(keyIssue, message));
      return false;
    }
    const issue = validateValue(key, value, repeated ? "repeated" : "single");
    if (issue) {
      setError(validationMessage(issue, message));
      return false;
    }
    if (repeated) {
      return run({ type: "add_repeated_property", entity, key, value });
    }
    const added = await run({ type: "set_property", entity, key, value });
    if (
      added &&
      key === "query.source" &&
      !bag.some((entry) => entry.key === "query.language")
    ) {
      return run({
        type: "set_property",
        entity,
        key: "query.language",
        value: { type: "string", value: "sparql-1.1/neoseq-v1" },
      });
    }
    return added;
  };

  return (
    <section className="props-section" data-testid={`props-${kind}`}>
      <header>
        {showHeading && <h3>{title}</h3>}
        {description && <p>{description}</p>}
      </header>
      <div className="props-list">
        {visible.length === 0 && (
          <p className="ac-hint">{message("properties.empty")}</p>
        )}
        {visible.map((entry, index) => (
          <PropertyRow
            key={`${entry.key}:${index}`}
            entry={entry}
            readonly={readonly}
            onCommit={(next) => void commitValue(entry, next)}
            onRemove={() => void removeEntry(entry)}
          />
        ))}
      </div>
      {!readonly && <AddPropertyRow kind={kind} onAdd={addEntry} />}
      {error && (
        <p className="field-error" role="alert" data-testid="props-error">
          {error}
        </p>
      )}
    </section>
  );
}

function PropertyRow({
  entry,
  readonly,
  onCommit,
  onRemove,
}: {
  entry: PropertyEntry;
  readonly: boolean;
  onCommit: (value: PropertyValue) => void;
  onRemove: () => void;
}) {
  const { message } = useI18n();
  const known = definition(entry.key);
  const repeated = cardinalityOf(entry.key) === "repeated";
  return (
    <div className="props-row" data-testid={`prop-${entry.key}`}>
      <span className="props-key" title={entry.key}>
        {entry.key}
        {!known && <span className="flag">{message("common.custom")}</span>}
        {repeated && <span className="flag">{message("common.repeated")}</span>}
      </span>
      <span className="props-value">
        <ValueEditor entryKey={entry.key} value={entry.value} readonly={readonly} onCommit={onCommit} />
      </span>
      {!readonly ? (
        <button
          className="icon-btn"
          aria-label={message("properties.remove", { key: entry.key })}
          data-testid={`remove-${entry.key}`}
          onClick={onRemove}
        >
          <XIcon />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}

/** A native checkbox tinted to the brand and sized to align with text rows. */
function Checkbox(props: ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      className="size-4 shrink-0 cursor-pointer accent-[var(--accent)]"
      {...props}
    />
  );
}

function ValueEditor({
  entryKey,
  value,
  readonly,
  onCommit,
}: {
  entryKey: string;
  value: PropertyValue;
  readonly: boolean;
  onCommit: (value: PropertyValue) => void;
}) {
  const { message } = useI18n();
  const state = useSessionState();
  const known = definition(entryKey);

  if (readonly) {
    return <ReadonlyValue value={value} />;
  }

  if (value.type === "checkbox") {
    return (
      <Checkbox
        checked={value.value}
        aria-label={message("properties.value", { key: entryKey })}
        onChange={(event) => onCommit({ type: "checkbox", value: event.target.checked })}
      />
    );
  }

  if (value.type === "date") {
    return (
      <Input
        type="date"
        value={value.value}
        aria-label={message("properties.value", { key: entryKey })}
        onChange={(event) => {
          if (event.target.value) onCommit({ type: "date", value: event.target.value });
        }}
      />
    );
  }

  if (value.type === "number") {
    return (
      <CommitOnBlurInput
        key={String(value.value)}
        type="number"
        initial={String(value.value)}
        label={message("properties.value", { key: entryKey })}
        onCommit={(raw) => {
          const parsed = Number(raw);
          if (!Number.isNaN(parsed)) onCommit({ type: "number", value: parsed });
        }}
      />
    );
  }

  if (value.type === "page") {
    const page = findPage(state.snapshot, value.value);
    const missing = !page || isDeleted(page);
    return (
      <>
        <span className="chip" data-tombstone={missing}>
          <span className="chip-link">{page ? pageTitle(page) : value.value}</span>
        </span>
        <PageAutocomplete
          placeholder={message("properties.replacePage")}
          onPick={(pageId) => onCommit({ type: "page", value: pageId })}
        />
      </>
    );
  }

  if (known && known.allowed_strings.length > 0) {
    return (
      <NativeSelect
        value={value.value}
        aria-label={message("properties.value", { key: entryKey })}
        onChange={(event) => onCommit({ type: "string", value: event.target.value })}
      >
        {known.allowed_strings.map((allowed) => (
          <option key={allowed} value={allowed}>
            {localizedAllowedValue(entryKey, allowed, message)}
          </option>
        ))}
      </NativeSelect>
    );
  }

  return (
    <CommitOnBlurInput
      key={value.value}
      type="text"
      initial={value.value}
      label={message("properties.value", { key: entryKey })}
      onCommit={(raw) => onCommit({ type: "string", value: raw })}
    />
  );
}

function ReadonlyValue({ value }: { value: PropertyValue }): ReactNode {
  const state = useSessionState();
  const { message } = useI18n();
  if (value.type === "checkbox") {
    return <Checkbox checked={value.value} disabled aria-label={message("common.value")} />;
  }
  if (value.type === "page") {
    const page = findPage(state.snapshot, value.value);
    return <span>{page ? pageTitle(page) : value.value}</span>;
  }
  return <span>{String(value.value)}</span>;
}

function CommitOnBlurInput({
  type,
  initial,
  label,
  onCommit,
}: {
  type: "text" | "number";
  initial: string;
  label: string;
  onCommit: (raw: string) => void;
}) {
  const [draft, setDraft] = useState(initial);
  const commit = () => {
    if (draft !== initial) onCommit(draft);
  };
  return (
    <Input
      type={type}
      value={draft}
      aria-label={label}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          commit();
        }
      }}
    />
  );
}

function AddPropertyRow({
  kind,
  onAdd,
}: {
  kind: BagKind;
  onAdd: (key: string, value: PropertyValue, repeated: boolean) => Promise<boolean>;
}) {
  const { message } = useI18n();
  const [key, setKey] = useState("");
  const [type, setType] = useState<PropertyValueType>("string");
  const [draft, setDraft] = useState<PropertyValue>({ type: "string", value: "" });
  const known = definition(key);
  const effectiveType = known?.type ?? type;
  const repeated = cardinalityOf(key) === "repeated";
  const datalistId = `prop-keys-${kind}`;

  const knownKeys = useMemo(
    () =>
      REGISTRY.filter(
        (item) => !isSystemKey(item.key),
      ).map((item) => item.key),
    [kind],
  );

  const syncType = (nextKey: string) => {
    setKey(nextKey);
    const item = definition(nextKey);
    const nextType = item?.type ?? type;
    if (nextType !== draft.type) {
      setType(nextType);
      setDraft(defaultValueFor(nextType, todayLocalDate()));
    }
  };

  const submit = async () => {
    const added = await onAdd(key, coerceDraft(draft, effectiveType), repeated);
    if (added) {
      setKey("");
      setType("string");
      setDraft({ type: "string", value: "" });
    }
  };

  return (
    <div className="props-add" data-testid={`props-add-${kind}`}>
      <div>
        <Input
          list={datalistId}
          placeholder={message("properties.propertyKey")}
          aria-label={message("properties.newKey")}
          value={key}
          onChange={(event) => syncType(event.target.value)}
        />
        <datalist id={datalistId}>
          {knownKeys.map((item) => (
            <option key={item} value={item} />
          ))}
        </datalist>
      </div>
      <NativeSelect
        aria-label={message("properties.newType")}
        value={effectiveType}
        disabled={known !== undefined}
        onChange={(event) => {
          const nextType = event.target.value as PropertyValueType;
          setType(nextType);
          setDraft(defaultValueFor(nextType, todayLocalDate()));
        }}
      >
        {VALUE_TYPES.map((item) => (
          <option key={item} value={item}>
            {message(`properties.type.${item}` as
              | "properties.type.string"
              | "properties.type.number"
              | "properties.type.checkbox"
              | "properties.type.date"
              | "properties.type.page")}
          </option>
        ))}
      </NativeSelect>
      <NewValueInput
        type={effectiveType}
        entryKey={key}
        draft={draft}
        onChange={setDraft}
        onSubmit={() => void submit()}
      />
      <Button variant="secondary" onClick={() => void submit()} data-testid="props-add-submit">
        {message("common.add")}
      </Button>
    </div>
  );
}

function coerceDraft(draft: PropertyValue, type: PropertyValueType): PropertyValue {
  if (draft.type === type) return draft;
  return defaultValueFor(type, todayLocalDate());
}

function NewValueInput({
  type,
  entryKey,
  draft,
  onChange,
  onSubmit,
}: {
  type: PropertyValueType;
  entryKey: string;
  draft: PropertyValue;
  onChange: (value: PropertyValue) => void;
  onSubmit: () => void;
}) {
  const { message } = useI18n();
  const known = definition(entryKey);
  const value = coerceDraft(draft, type);

  if (type === "checkbox") {
    return (
      <div className="flex h-8 items-center">
        <Checkbox
          aria-label={message("properties.newValue")}
          checked={value.type === "checkbox" && value.value}
          onChange={(event) => onChange({ type: "checkbox", value: event.target.checked })}
        />
      </div>
    );
  }
  if (type === "date") {
    return (
      <Input
        type="date"
        aria-label={message("properties.newValue")}
        value={value.type === "date" ? value.value : ""}
        onChange={(event) => onChange({ type: "date", value: event.target.value })}
      />
    );
  }
  if (type === "number") {
    return (
      <Input
        type="number"
        aria-label={message("properties.newValue")}
        value={value.type === "number" ? String(value.value) : "0"}
        onChange={(event) => onChange({ type: "number", value: Number(event.target.value) })}
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit();
        }}
      />
    );
  }
  if (type === "page") {
    return (
      <PageAutocomplete
        placeholder={message("properties.pickPage")}
        allowCreate
        onPick={(pageId) => onChange({ type: "page", value: pageId })}
      />
    );
  }
  if (known && known.allowed_strings.length > 0) {
    return (
      <NativeSelect
        aria-label={message("properties.newValue")}
        value={value.type === "string" ? value.value : known.allowed_strings[0]}
        onChange={(event) => onChange({ type: "string", value: event.target.value })}
      >
        <option value="">{message("properties.choose")}</option>
        {known.allowed_strings.map((allowed) => (
          <option key={allowed} value={allowed}>
            {localizedAllowedValue(entryKey, allowed, message)}
          </option>
        ))}
      </NativeSelect>
    );
  }
  return (
    <Input
      aria-label={message("properties.newValue")}
      placeholder={message("properties.valuePlaceholder")}
      value={value.type === "string" ? value.value : ""}
      onChange={(event) => onChange({ type: "string", value: event.target.value })}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) onSubmit();
      }}
    />
  );
}

function localizedAllowedValue(
  key: string,
  value: string,
  message: MessageFunction,
): string {
  if (key === "task.status" && ["todo", "doing", "done"].includes(value)) {
    return message(`task.status.${value}` as
      | "task.status.todo"
      | "task.status.doing"
      | "task.status.done");
  }
  if (key === "task.priority" && ["low", "medium", "high"].includes(value)) {
    return message(`task.priority.${value}` as
      | "task.priority.low"
      | "task.priority.medium"
      | "task.priority.high");
  }
  return value;
}

function validationMessage(issue: ValidationIssue, message: MessageFunction): string {
  const values = issue.values ?? {};
  switch (issue.code) {
    case "reserved_key":
      return message("validation.reservedKey", { key: values.key });
    case "property_type":
      return message("validation.propertyType", { key: values.key, type: values.type });
    case "property_cardinality":
      return message("validation.propertyCardinality", {
        key: values.key,
        cardinality: values.cardinality,
      });
    case "property_strings":
      return message("validation.propertyStrings", { key: values.key, values: values.values });
    case "default_forbidden":
      return message("validation.defaultForbidden", { key: values.key });
    case "control_character":
      return message("validation.controlCharacter");
    case "date":
      return message("validation.date");
    case "empty_key":
      return message("validation.emptyKey");
    case "empty_page":
      return message("validation.emptyPage");
    case "finite_number":
      return message("validation.finiteNumber");
    case "key_length":
      return message("validation.keyLength");
    case "string_length":
      return message("validation.stringLength");
    case "whitespace_key":
      return message("validation.whitespaceKey");
  }
}
