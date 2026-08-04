// One generic editor for every property bag: block properties, page
// properties, and page default bags. Well-known keys get richer inputs
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
  validateDefault,
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

export type BagKind = "block" | "page" | "defaults";

type PropertyBagEditorProps = {
  targetId: string;
  bag: PropertyEntry[];
  title: string;
  description?: string;
  /** False when an enclosing disclosure already names this bag. */
  showHeading?: boolean;
} & (
  | { kind: "block"; pageId: string }
  | { kind: "page" | "defaults"; pageId?: never }
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
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    }
  };

  const validate = (key: string, value: PropertyValue): ValidationIssue | null =>
    kind === "defaults" ? validateDefault(key, value) : validateValue(key, value, cardinalityOf(key));

  const commitValue = async (entry: PropertyEntry, next: PropertyValue) => {
    if (sameValue(entry.value, next)) return;
    const issue = validate(entry.key, next);
    if (issue) {
      setError(issue.message);
      return;
    }
    if (kind === "defaults") {
      await run({ type: "set_page_default", page_id: targetId, key: entry.key, value: next });
    } else if (cardinalityOf(entry.key) === "repeated") {
      const added = await run({ type: "add_repeated_property", entity, key: entry.key, value: next });
      if (added) {
        await run({ type: "remove_repeated_property", entity, key: entry.key, value: entry.value });
      }
    } else {
      await run({ type: "set_property", entity, key: entry.key, value: next });
    }
  };

  const removeEntry = async (entry: PropertyEntry) => {
    if (kind === "defaults") {
      await run({ type: "remove_page_default", page_id: targetId, key: entry.key });
    } else if (cardinalityOf(entry.key) === "repeated") {
      await run({ type: "remove_repeated_property", entity, key: entry.key, value: entry.value });
    } else {
      await run({ type: "remove_property", entity, key: entry.key });
    }
  };

  const addEntry = async (key: string, value: PropertyValue, repeated: boolean) => {
    const keyIssue = validateKey(key);
    if (keyIssue) {
      setError(keyIssue.message);
      return false;
    }
    const issue =
      kind === "defaults"
        ? validateDefault(key, value)
        : validateValue(key, value, repeated ? "repeated" : "single");
    if (issue) {
      setError(issue.message);
      return false;
    }
    if (kind === "defaults") {
      return run({ type: "set_page_default", page_id: targetId, key, value });
    }
    if (repeated) {
      return run({ type: "add_repeated_property", entity, key, value });
    }
    return run({ type: "set_property", entity, key, value });
  };

  return (
    <section className="props-section" data-testid={`props-${kind}`}>
      <header>
        {showHeading && <h3>{title}</h3>}
        {description && <p>{description}</p>}
      </header>
      <div className="props-list">
        {visible.length === 0 && <p className="ac-hint">No properties yet.</p>}
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
  const known = definition(entry.key);
  const repeated = cardinalityOf(entry.key) === "repeated";
  return (
    <div className="props-row" data-testid={`prop-${entry.key}`}>
      <span className="props-key" title={entry.key}>
        {entry.key}
        {!known && <span className="flag">custom</span>}
        {repeated && <span className="flag">repeated</span>}
      </span>
      <span className="props-value">
        <ValueEditor entryKey={entry.key} value={entry.value} readonly={readonly} onCommit={onCommit} />
      </span>
      {!readonly ? (
        <button
          className="icon-btn"
          aria-label={`Remove ${entry.key}`}
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
  const state = useSessionState();
  const known = definition(entryKey);

  if (readonly) {
    return <ReadonlyValue value={value} />;
  }

  if (value.type === "checkbox") {
    return (
      <Checkbox
        checked={value.value}
        aria-label={`${entryKey} value`}
        onChange={(event) => onCommit({ type: "checkbox", value: event.target.checked })}
      />
    );
  }

  if (value.type === "date") {
    return (
      <Input
        type="date"
        value={value.value}
        aria-label={`${entryKey} value`}
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
        label={`${entryKey} value`}
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
          placeholder="Replace page reference"
          onPick={(pageId) => onCommit({ type: "page", value: pageId })}
        />
      </>
    );
  }

  if (known && known.allowed_strings.length > 0) {
    return (
      <NativeSelect
        value={value.value}
        aria-label={`${entryKey} value`}
        onChange={(event) => onCommit({ type: "string", value: event.target.value })}
      >
        {known.allowed_strings.map((allowed) => (
          <option key={allowed} value={allowed}>
            {allowed}
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
      label={`${entryKey} value`}
      onCommit={(raw) => onCommit({ type: "string", value: raw })}
    />
  );
}

function ReadonlyValue({ value }: { value: PropertyValue }): ReactNode {
  const state = useSessionState();
  if (value.type === "checkbox") {
    return <Checkbox checked={value.value} disabled aria-label="value" />;
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
  const [key, setKey] = useState("");
  const [type, setType] = useState<PropertyValueType>("string");
  const [draft, setDraft] = useState<PropertyValue>({ type: "string", value: "" });
  const known = definition(key);
  const effectiveType = known?.type ?? type;
  const repeated = kind !== "defaults" && cardinalityOf(key) === "repeated";
  const datalistId = `prop-keys-${kind}`;

  const knownKeys = useMemo(
    () =>
      REGISTRY.filter(
        (item) => !isSystemKey(item.key) && (kind !== "defaults" || item.defaultable),
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
          placeholder="Property key"
          aria-label="New property key"
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
        aria-label="New property type"
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
            {item}
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
        Add
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
  const known = definition(entryKey);
  const value = coerceDraft(draft, type);

  if (type === "checkbox") {
    return (
      <div className="flex h-8 items-center">
        <Checkbox
          aria-label="New property value"
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
        aria-label="New property value"
        value={value.type === "date" ? value.value : ""}
        onChange={(event) => onChange({ type: "date", value: event.target.value })}
      />
    );
  }
  if (type === "number") {
    return (
      <Input
        type="number"
        aria-label="New property value"
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
        placeholder="Pick a page"
        allowCreate
        onPick={(pageId) => onChange({ type: "page", value: pageId })}
      />
    );
  }
  if (known && known.allowed_strings.length > 0) {
    return (
      <NativeSelect
        aria-label="New property value"
        value={value.type === "string" ? value.value : known.allowed_strings[0]}
        onChange={(event) => onChange({ type: "string", value: event.target.value })}
      >
        <option value="">choose…</option>
        {known.allowed_strings.map((allowed) => (
          <option key={allowed} value={allowed}>
            {allowed}
          </option>
        ))}
      </NativeSelect>
    );
  }
  return (
    <Input
      aria-label="New property value"
      placeholder="Value"
      value={value.type === "string" ? value.value : ""}
      onChange={(event) => onChange({ type: "string", value: event.target.value })}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) onSubmit();
      }}
    />
  );
}
