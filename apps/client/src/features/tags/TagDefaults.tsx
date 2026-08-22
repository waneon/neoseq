// What a tag copies onto whatever it is added to.
//
// The same chip language the outline speaks, so a default reads as the value it
// will become. It is written in exactly one place — the tag's own page, through
// the shared contextual `PropertyPicker` on a tag-default owner — and read
// wherever a tag is listed. Passing no `onEdit` is what makes it a reading: the
// chips become plain text, and nothing on the surface claims to be a control.

import { PlusIcon } from "lucide-react";
import type { PropertyField, PropertyValue, TagSnapshot } from "../../core-port/snapshot";
import { findPage, isDeleted, pageTitle } from "../../core-port/snapshot";
import { TASK_PRIORITY_KEY, TASK_STATUS_KEY } from "../../entities/tasks";
import { useI18n } from "../../i18n";
import { useSessionState } from "../shell/session-context";
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
  const state = useSessionState();
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
  const describeField = (field: PropertyField): string =>
    field.values.length === 0
      ? message("properties.noValue")
      : field.values.map((value) => describe(field.key, value)).join(", ");

  const body = (field: PropertyField) => (
    <>
      {propertyGlyph(field.key, field.value_type)}
      <span className="task-chip-name">{propertyDisplayName(field.key, message)}</span>
      <span className="task-chip-value">{describeField(field)}</span>
    </>
  );

  return (
    <div className="tag-defaults" aria-label={message("tags.defaultsFor", { name: tag.name })}>
      {tag.defaults.map((field) =>
        onEdit ? (
          <button
            key={field.key}
            type="button"
            className="task-chip"
            data-testid={`tag-default-${field.key}`}
            title={`${field.key}: ${describeField(field)}`}
            onClick={(event) => onEdit(field.key, event.currentTarget)}
          >
            {body(field)}
          </button>
        ) : (
          <span
            key={field.key}
            className="task-chip"
            data-testid={`tag-default-${field.key}`}
            title={`${field.key}: ${describeField(field)}`}
          >
            {body(field)}
          </span>
        ),
      )}
      {!onEdit && tag.defaults.length === 0 && (
        <span className="tag-no-defaults">{message("tags.noDefaults")}</span>
      )}
      {onEdit && (
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
  );
}
