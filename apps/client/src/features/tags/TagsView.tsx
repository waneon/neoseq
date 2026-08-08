// The graph's tags, and what each one does to a block.
//
// A tag is more than a label here: its *defaults* are copied onto a block the
// moment the tag is added (never overwriting a value the block already has).
// This screen owns the tag lifecycle — it is the one place a tag is created
// or deleted; the outline's `#` menu and the block tag picker only attach
// tags that already exist. One card per tag: the name in the tag's own `#`
// voice, its defaults in the same chip language the outline speaks, and the
// same contextual PropertyPicker as everywhere else, opened on a tag-default
// owner so writes travel through the common property command family.

import { useEffect, useRef, useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import type { PropertyValue, TagSnapshot } from "../../core-port/snapshot";
import { findPage, findTag, isDeleted, pageTitle } from "../../core-port/snapshot";
import { canonicalEntityName } from "../../entities/names";
import { TASK_PRIORITY_KEY, TASK_STATUS_KEY } from "../../entities/tasks";
import { useI18n } from "../../i18n";
import { useNotify } from "../notify/context";
import { useSession, useSessionState } from "../shell/session-context";
import { PropertyPicker } from "../properties/PropertyPicker";
import { propertyDisplayName, propertyGlyph } from "../properties/property-display";
import { priorityLabel, statusLabel } from "../tasks/labels";
import { Dialog } from "../../ui/components";
import { Input } from "@/ui/shadcn/input";

interface PickerRequest {
  tagId: string;
  key?: string;
  anchor: HTMLElement | null;
}

export function TagsView() {
  const session = useSession();
  const state = useSessionState();
  const notify = useNotify();
  const { message, compare } = useI18n();
  const [picker, setPicker] = useState<PickerRequest | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<TagSnapshot | null>(null);
  const readonly = state.mode === "readonly";

  const tags = [...state.snapshot.tags].sort((left, right) => compare(left.name, right.name));
  // The bag is re-read from the snapshot on every render, so the open picker
  // always edits the authoritative defaults rather than a stale copy.
  const pickerTag = picker ? findTag(state.snapshot, picker.tagId) : undefined;

  const deleteTag = (tag: TagSnapshot) => {
    setConfirmDelete(null);
    void session.execute({ type: "delete_tag", tag_id: tag.id }).catch((error: unknown) => {
      // The card stays put on failure, which on its own reads as a click
      // that did not register.
      notify.failure(message("failure.deleteTag", { name: tag.name }), error);
    });
  };

  return (
    <div className="page-scroll">
      <article className="page-body enter-fade-view">
        <div className="title-row">
          <h1>{message("tags.title")}</h1>
        </div>
        <p className="tags-hint">{message("tags.hint")}</p>
        {readonly && tags.length === 0 ? (
          <p className="tags-empty" data-testid="tags-empty">
            {message("tags.empty")}
          </p>
        ) : (
          <ul className="tag-grid" data-testid="tag-list">
            {tags.map((tag) => (
              <TagCard
                key={tag.id}
                tag={tag}
                onEdit={(key, anchor) => setPicker({ tagId: tag.id, key, anchor })}
                onDelete={() => setConfirmDelete(tag)}
              />
            ))}
            {!readonly && <NewTagCard existing={tags} />}
          </ul>
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
      {confirmDelete && (
        <Dialog title={message("tags.deleteTitle")} onClose={() => setConfirmDelete(null)}>
          <p>{message("tags.deleteConfirm", { name: confirmDelete.name })}</p>
          <div className="dialog-actions">
            <button className="btn" onClick={() => setConfirmDelete(null)}>
              {message("common.cancel")}
            </button>
            <button
              className="btn btn-danger"
              data-testid="confirm-delete-tag"
              onClick={() => deleteTag(confirmDelete)}
            >
              {message("tags.deleteAction")}
            </button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function TagCard({
  tag,
  onEdit,
  onDelete,
}: {
  tag: TagSnapshot;
  onEdit: (key: string | undefined, anchor: HTMLElement) => void;
  onDelete: () => void;
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
  const describeField = (field: TagSnapshot["defaults"][number]): string =>
    field.values.length === 0
      ? message("properties.noValue")
      : field.values.map((value) => describe(field.key, value)).join(", ");

  return (
    <li className="tag-card" data-testid="tag-card">
      <div className="tag-card-head">
        <span className="tag-card-name">
          <span className="hash" aria-hidden>
            #
          </span>
          {tag.name}
        </span>
        {!readonly && (
          <button
            type="button"
            className="icon-btn tag-card-delete"
            aria-label={message("tags.deleteNamed", { name: tag.name })}
            data-testid="tag-delete"
            onClick={onDelete}
          >
            <Trash2Icon aria-hidden />
          </button>
        )}
      </div>
      <div
        className="tag-card-defaults"
        aria-label={message("tags.defaultsFor", { name: tag.name })}
      >
        {tag.defaults.map((field) => (
          <button
            key={field.key}
            type="button"
            className="task-chip"
            data-testid={`tag-default-${field.key}`}
            title={`${field.key}: ${describeField(field)}`}
            onClick={(event) => onEdit(field.key, event.currentTarget)}
          >
            {propertyGlyph(field.key, field.value_type)}
            <span className="task-chip-name">{propertyDisplayName(field.key, message)}</span>
            <span className="task-chip-value">{describeField(field)}</span>
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

/**
 * The create card — the one place a tag comes into existence. At rest it is a
 * quiet ringed card with a plus; pressed, it becomes an inline name field.
 * `⏎` creates and keeps the field open for the next name; `Esc` or leaving
 * the field closes it without creating anything.
 */
function NewTagCard({ existing }: { existing: TagSnapshot[] }) {
  const session = useSession();
  const notify = useNotify();
  const { message } = useI18n();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const create = async () => {
    const name = draft.trim();
    if (!name) return;
    const canonical = canonicalEntityName(name);
    if (existing.some((tag) => canonicalEntityName(tag.name) === canonical)) {
      notify.show({
        tone: "info",
        key: "tag-duplicate",
        title: message("tags.duplicate", { name }),
      });
      return;
    }
    try {
      await session.execute({
        type: "ensure_tag",
        tag_id: `t-${crypto.randomUUID()}`,
        name,
      });
      setDraft("");
      inputRef.current?.focus();
    } catch (error) {
      notify.failure(message("failure.createEntity", { name }), error);
    }
  };

  if (!editing) {
    return (
      <li className="tag-card-new-slot">
        <button
          type="button"
          className="tag-card-new"
          data-testid="tag-card-new"
          onClick={() => setEditing(true)}
        >
          <PlusIcon aria-hidden />
          {message("tags.new")}
        </button>
      </li>
    );
  }

  return (
    <li className="tag-card tag-card-editing">
      <div className="tag-card-head">
        <span className="tag-card-name">
          <span className="hash" aria-hidden>
            #
          </span>
        </span>
        <Input
          ref={inputRef}
          aria-label={message("tags.new")}
          placeholder={message("tags.namePlaceholder")}
          data-testid="new-tag-name"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => {
            setEditing(false);
            setDraft("");
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") {
              event.preventDefault();
              void create();
            } else if (event.key === "Escape") {
              event.preventDefault();
              setEditing(false);
              setDraft("");
            }
          }}
        />
      </div>
    </li>
  );
}
