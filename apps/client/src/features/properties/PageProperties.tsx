import { useCallback, useEffect, useRef, useState } from "react";
import type { PageSnapshot, PropertyValue } from "../../core-port/snapshot";
import { findPage, isDeleted, pageTitle } from "../../core-port/snapshot";
import { isGenericProperty } from "../../entities/properties";
import { useI18n } from "../../i18n";
import { useCommands } from "../commands/context";
import { useSessionState } from "../shell/session-context";
import { PropertyPicker } from "./PropertyPicker";

const STRIP_LIMIT = 4;

/** Page metadata stays visible as a compact strip; every edit goes through one picker. */
export function PageProperties({
  page,
  open,
  onOpenChange,
}: {
  page: PageSnapshot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const commands = useCommands();
  const state = useSessionState();
  const { message } = useI18n();
  const anchorRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const openedFromHere = useRef(false);
  const [initialKey, setInitialKey] = useState<string | undefined>();

  const show = useCallback((key?: string, anchor?: HTMLElement) => {
    openedFromHere.current = true;
    setInitialKey(key);
    restoreFocus.current = anchor ?? (document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null);
    onOpenChange(true);
  }, [onOpenChange]);

  useEffect(() => {
    if (!open) return;
    if (openedFromHere.current) {
      openedFromHere.current = false;
      return;
    }
    // PageView's title menu owns only the boolean disclosure state. Treat that
    // route as a fresh add/change request, never as a replay of the last row.
    setInitialKey(undefined);
  }, [open]);

  const close = () => {
    onOpenChange(false);
    requestAnimationFrame(() => restoreFocus.current?.focus({ preventScroll: true }));
  };

  useEffect(() => {
    commands.setPageProperties(() => show());
    return () => commands.setPageProperties(null);
  }, [commands, show]);

  return (
    <div className="page-inline-properties" ref={anchorRef}>
      {page.properties.some((entry) => isGenericProperty(entry.key)) && (
        <div className="prop-strip">
          {page.properties
            .filter((entry) => isGenericProperty(entry.key))
            .slice(0, STRIP_LIMIT)
            .map((entry, index) => (
              <button
                key={`${entry.key}:${index}`}
                className="prop-strip-chip"
                data-testid={`prop-${entry.key}`}
                onClick={(event) => show(entry.key, event.currentTarget)}
              >
                <span className="key">{entry.key}</span>
                <span className="value">{describe(entry.value, state, message)}</span>
              </button>
            ))}
          {page.properties.filter((entry) => isGenericProperty(entry.key)).length > STRIP_LIMIT && (
            <button className="prop-strip-chip" onClick={(event) => show(undefined, event.currentTarget)}>
              {message("properties.more", {
                count: page.properties.filter((entry) => isGenericProperty(entry.key)).length - STRIP_LIMIT,
              })}
            </button>
          )}
        </div>
      )}
      {open && (
        <PropertyPicker
          key={`${page.id}:${initialKey ?? "new"}`}
          target={{ kind: "page", id: page.id, bag: page.properties }}
          anchor={restoreFocus.current ?? anchorRef.current}
          initialKey={initialKey}
          onClose={close}
        />
      )}
    </div>
  );
}

function describe(
  value: PropertyValue,
  state: ReturnType<typeof useSessionState>,
  message: ReturnType<typeof useI18n>["message"],
): string {
  if (value.type === "checkbox") return value.value ? message("common.yes") : message("common.no");
  if (value.type === "page") {
    const target = findPage(state.snapshot, value.value);
    if (!target) return value.value;
    return isDeleted(target)
      ? message("properties.deleted", { name: pageTitle(target) })
      : pageTitle(target);
  }
  return String(value.value);
}
