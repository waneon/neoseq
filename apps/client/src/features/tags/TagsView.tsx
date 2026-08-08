// The graph's tags, and what each one does to a block.
//
// A tag is more than a label here: its *defaults* are copied onto a block the
// moment the tag is added (never overwriting a value the block already has).
// This screen is where that behavior is visible and editable — one quiet row
// per tag, its defaults in the same chip language the outline speaks, and the
// same contextual PropertyPicker as everywhere else, opened on a `tag` target
// so writes travel as `set_tag_default` / `remove_tag_default`.

import { useState } from "react";
import { PlusIcon } from "lucide-react";
import type { PropertyValue, TagSnapshot } from "../../core-port/snapshot";
import { findPage, findTag, isDeleted, pageTitle } from "../../core-port/snapshot";
import { TASK_PRIORITY_KEY, TASK_STATUS_KEY } from "../../entities/tasks";
import { useI18n } from "../../i18n";
import { useSessionState } from "../shell/session-context";
import { PropertyPicker } from "../properties/PropertyPicker";
import { propertyDisplayName, propertyGlyph } from "../properties/property-display";
import { priorityLabel, statusLabel } from "../tasks/labels";

interface PickerRequest {
  tagId: string;
  key?: string;
  anchor: HTMLElement | null;
}

export function TagsView() {
  const state = useSessionState();
  const { message, compare } = useI18n();
  const [picker, setPicker] = useState<PickerRequest | null>(null);

  const tags = [...state.snapshot.tags].sort((left, right) => compare(left.name, right.name));
  // The bag is re-read from the snapshot on every render, so the open picker
  // always edits the authoritative defaults rather than a stale copy.
  const pickerTag = picker ? findTag(state.snapshot, picker.tagId) : undefined;

  return (
    <div className="page-scroll">
      <article className="page-body enter-fade-view">
        <div className="title-row">
          <h1>{message("tags.title")}</h1>
        </div>
        {tags.length === 0 ? (
          <p className="tags-empty" data-testid="tags-empty">
            {message("tags.empty")}
          </p>
        ) : (
          <>
            <p className="tags-hint">{message("tags.hint")}</p>
            <ul className="tag-list" data-testid="tag-list">
              {tags.map((tag) => (
                <TagRow
                  key={tag.id}
                  tag={tag}
                  onEdit={(key, anchor) => setPicker({ tagId: tag.id, key, anchor })}
                />
              ))}
            </ul>
          </>
        )}
      </article>
      {picker && pickerTag && (
        <PropertyPicker
          target={{ kind: "tag", id: pickerTag.id, bag: pickerTag.defaults }}
          anchor={picker.anchor}
          initialKey={picker.key}
          onClose={() => setPicker(null)}
        />
      )}
    </div>
  );
}

function TagRow({
  tag,
  onEdit,
}: {
  tag: TagSnapshot;
  onEdit: (key: string | undefined, anchor: HTMLElement) => void;
}) {
  const state = useSessionState();
  const { message, formatJournalDate } = useI18n();
  const readonly = state.mode === "readonly";

  const describe = (key: string, value: PropertyValue): string => {
    if (value.type === "checkbox") {
      return value.value ? message("common.yes") : message("common.no");
    }
    if (value.type === "date") return formatJournalDate(value.value);
    if (value.type === "page") {
      const page = findPage(state.snapshot, value.value);
      if (!page) return value.value;
      return isDeleted(page)
        ? message("properties.deleted", { name: pageTitle(page) })
        : pageTitle(page);
    }
    if (key === TASK_STATUS_KEY) return statusLabel(String(value.value), message);
    if (key === TASK_PRIORITY_KEY) return priorityLabel(String(value.value), message);
    return String(value.value);
  };

  return (
    <li className="tag-row" data-testid="tag-row">
      <span className="tag-row-name">
        <span className="hash" aria-hidden>
          #
        </span>
        {tag.name}
      </span>
      <div
        className="tag-row-defaults"
        aria-label={message("tags.defaultsFor", { name: tag.name })}
      >
        {tag.defaults.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className="task-chip"
            data-testid={`tag-default-${entry.key}`}
            title={`${entry.key}: ${describe(entry.key, entry.value)}`}
            onClick={(event) => onEdit(entry.key, event.currentTarget)}
          >
            {propertyGlyph(entry.key, entry.value.type)}
            <span className="task-chip-name">{propertyDisplayName(entry.key, message)}</span>
            <span className="task-chip-value">{describe(entry.key, entry.value)}</span>
          </button>
        ))}
        {readonly && tag.defaults.length === 0 && (
          <span className="tag-no-defaults">{message("tags.noDefaults")}</span>
        )}
        {!readonly && (
          <button
            type="button"
            className="tag-add-default"
            data-testid="tag-add-default"
            onClick={(event) => onEdit(undefined, event.currentTarget)}
          >
            <PlusIcon aria-hidden />
            {message("tags.addDefault")}
          </button>
        )}
      </div>
    </li>
  );
}
