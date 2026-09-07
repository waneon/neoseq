import { useId, useState } from "react";
import { ChevronDownIcon, PlusIcon } from "lucide-react";
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
  onEdit?: (key: string | undefined, anchor: HTMLElement) => void;
}) {
  const { message } = useI18n();
  const describeField = useDefaultDescription();
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();

  return (
    <section
      className="tag-defaults"
      data-testid="tag-defaults"
      aria-label={message("tags.defaultsFor", { name: tag.name })}
    >
      <div className="tag-section-head">
        <h2>
          <button
            type="button"
            className="tag-defaults-toggle"
            data-testid="tag-defaults-toggle"
            aria-expanded={expanded}
            aria-controls={contentId}
            onClick={() => setExpanded((current) => !current)}
          >
            <ChevronDownIcon aria-hidden />
            <span>{message("tags.defaults")}</span>
            <span className="tag-defaults-count">
              {message("tags.defaultsCount", { count: tag.defaults.length })}
            </span>
          </button>
        </h2>
        {onEdit && (
          <button
            type="button"
            className="tag-section-action"
            data-testid="tag-add-default"
            aria-haspopup="dialog"
            onClick={(event) => {
              setExpanded(true);
              onEdit(undefined, event.currentTarget);
            }}
          >
            <PlusIcon aria-hidden />
            {message("tags.addDefault")}
          </button>
        )}
      </div>
      <div className="tag-defaults-content" id={contentId} hidden={!expanded}>
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
                    aria-haspopup={onEdit ? "dialog" : undefined}
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
      </div>
    </section>
  );
}

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
