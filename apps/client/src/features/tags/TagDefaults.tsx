// What a tag copies onto whatever it is added to.
//
// This used to be a row of chips wedged under the tag's name, which is the one
// shape that cannot say the thing that matters here: a default is a **key and a
// value**, and a chip puts them side by side in one run of small text where
// neither has a column. Six of them wrapped into a paragraph of grey.
//
// So it is a named section of rows now — the design in designs/metadata.md § Tag
// Directory and Tag Page. A glyph column, a key column, a value column: three
// tags' defaults read *down* as three lists rather than across as one blur. The
// heading says what the rows are and the note says what they do, because
// "default" on its own says neither.
//
// Editing still goes through the one contextual `PropertyPicker` every other
// owner uses, opened on the row it belongs to. Removal lives inside it, where the
// reader who came to change a value can also clear it — a second `×` on the row
// would be a second pointer route to one capability.

import { PlusIcon } from "lucide-react";
import type { PropertyField, PropertyValue, TagSnapshot } from "../../core-port/snapshot";
import { findPage, isDeleted, pageTitle } from "../../core-port/snapshot";
import { TASK_PRIORITY_KEY, TASK_STATUS_KEY } from "../../entities/tasks";
import { useI18n } from "../../i18n";
import { useSessionSelector } from "../shell/session-context";
import { propertyDisplayName, propertyGlyph } from "../properties/property-display";
import { priorityLabel, statusLabel } from "../tasks/labels";

export function TagDefaults({
  tag,
  onEdit,
}: {
  tag: TagSnapshot;
  /** Absent means this is a reading of the defaults, not the place they are set. */
  onEdit?: (key: string | undefined, anchor: HTMLElement) => void;
}) {
  const { message } = useI18n();
  const describeField = useDefaultDescription();

  return (
    <section className="tag-defaults" data-testid="tag-defaults">
      <div className="tag-section-head">
        <h2>{message("tags.defaults")}</h2>
        {onEdit && (
          <button
            type="button"
            className="tag-section-action"
            data-testid="tag-add-default"
            onClick={(event) => onEdit(undefined, event.currentTarget)}
          >
            <PlusIcon aria-hidden />
            {message("tags.addDefault")}
          </button>
        )}
      </div>
      {/* The note *is* the empty state. It says what a default is, which is the
          question a section with nothing in it raises and a section with three
          rows in it has already answered — and saying "nothing yet" beside it
          would be the same fact twice on one screen. */}
      {tag.defaults.length === 0 ? (
        <p className="tag-section-note">{message("tags.defaultsNote")}</p>
      ) : (
        <ul className="tag-default-rows">
          {tag.defaults.map((field) => {
            const value = describeField(field);
            const name = propertyDisplayName(field.key, message);
            return (
              <li key={field.key}>
                <button
                  type="button"
                  className="tag-default-row"
                  disabled={!onEdit}
                  data-testid={`tag-default-${field.key}`}
                  aria-label={`${name}: ${value}`}
                  onClick={(event) => onEdit?.(field.key, event.currentTarget)}
                >
                  <span className="tag-default-glyph" aria-hidden>
                    {propertyGlyph(field.key, field.value_type)}
                  </span>
                  <span className="tag-default-key">{name}</span>
                  <span className="tag-default-value">{value}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/**
 * A default's value in the words the rest of the product uses for it: a status is
 * its own name, a page reference is that page's title, a date is the reader's own
 * journal format. Never a raw stored value.
 */
function useDefaultDescription(): (field: PropertyField) => string {
  const state = useSessionSelector(
    (current) => current,
    (left, right) => left.snapshot === right.snapshot,
  );
  const { message, formatJournalDate } = useI18n();

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

  return (field: PropertyField) =>
    field.values.length === 0
      ? message("properties.noValue")
      : field.values.map((value) => describe(field.key, value)).join(", ");
}
