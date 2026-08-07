import type { PropertyEntry, PropertyValue } from "../../core-port/snapshot";
import { findPage, isDeleted, pageTitle } from "../../core-port/snapshot";
import { cardinalityOf, isSystemKey } from "../../entities/properties";
import { useI18n } from "../../i18n";
import { useSessionState } from "../shell/session-context";

export function PropertyRows({
  bag,
  onEdit,
}: {
  bag: PropertyEntry[];
  onEdit: (key: string, anchor: HTMLElement) => void;
}) {
  const state = useSessionState();
  const { message } = useI18n();
  const visible = bag.filter((entry) => !isSystemKey(entry.key));
  if (visible.length === 0) return null;

  return (
    <div className="inline-properties" data-testid="inline-properties">
      {visible.map((entry, index) => (
        <button
          key={`${entry.key}:${index}`}
          className="inline-property-row"
          data-testid={`prop-${entry.key}`}
          onClick={(event) => onEdit(entry.key, event.currentTarget)}
          title={`${entry.key}: ${describe(entry.value, state.snapshot, message)}`}
        >
          <span className="inline-property-key">{entry.key}</span>
          <span className="inline-property-value">
            {describe(entry.value, state.snapshot, message)}
          </span>
          {cardinalityOf(entry.key) === "repeated" && (
            <span className="flag">{message("common.repeated")}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function describe(
  value: PropertyValue,
  snapshot: ReturnType<typeof useSessionState>["snapshot"],
  message: ReturnType<typeof useI18n>["message"],
): string {
  if (value.type === "checkbox") return value.value ? message("common.yes") : message("common.no");
  if (value.type === "page") {
    const page = findPage(snapshot, value.value);
    if (!page) return value.value;
    return isDeleted(page)
      ? message("properties.deleted", { name: pageTitle(page) })
      : pageTitle(page);
  }
  if (value.type === "query") return `${value.value.language}: ${value.value.source}`;
  return String(value.value);
}
