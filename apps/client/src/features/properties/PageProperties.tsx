import { useCallback, useEffect, useRef, useState } from "react";
import type { PageSnapshot, PropertyField, PropertyValue } from "../../core-port/snapshot";
import type { SessionState } from "../../core-port/session";
import { findPage, isDeleted, pageTitle } from "../../core-port/snapshot";
import { isGenericProperty } from "../../entities/properties";
import { useI18n } from "../../i18n";
import { useCommands } from "../commands/context";
import { useSessionSelector } from "../shell/session-context";
import { propertyDisplayName, propertyGlyph } from "./property-display";
import { PropertyPicker } from "./PropertyPicker";
import { elementAnchor, snapshotAnchor, type Anchor } from "@/ui/anchored";

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
  const state = useSessionSelector(
    (current) => current,
    (left, right) => left.snapshot === right.snapshot,
  );
  const { message } = useI18n();
  const anchorRef = useRef<HTMLDivElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const pickerAnchor = useRef<Anchor>(null);
  const openedFromHere = useRef(false);
  const [initialKey, setInitialKey] = useState<string | undefined>();

  const show = useCallback(
    (key?: string, anchor?: HTMLElement) => {
      openedFromHere.current = true;
      setInitialKey(key);
      const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const invokedFromPalette = Boolean(active?.closest('[data-testid="command-palette"]'));
      restoreFocus.current =
        anchor ??
        (!invokedFromPalette ? active : null) ??
        document.querySelector<HTMLElement>('[data-testid="page-title"]');
      // The command palette disappears before this picker measures. The page strip
      // is the durable owner of this surface; a palette input is only the route that
      // summoned it, never a geometry source that may survive the transition.
      pickerAnchor.current = anchor
        ? elementAnchor(anchor)
        : snapshotAnchor(elementAnchor(anchorRef.current));
      onOpenChange(true);
    },
    [onOpenChange],
  );

  useEffect(() => {
    if (!open) return;
    if (openedFromHere.current) {
      openedFromHere.current = false;
      return;
    }
    // PageView's title menu owns only the boolean disclosure state. Treat that
    // route as a fresh add/change request, never as a replay of the last row.
    setInitialKey(undefined);
    pickerAnchor.current = snapshotAnchor(elementAnchor(anchorRef.current));
    restoreFocus.current = document.querySelector<HTMLElement>('[data-testid="page-title"]');
  }, [open]);

  const close = () => {
    onOpenChange(false);
    queueMicrotask(() => {
      const target = restoreFocus.current?.isConnected
        ? restoreFocus.current
        : document.querySelector<HTMLElement>('[data-testid="page-title"]');
      target?.focus({ preventScroll: true });
    });
  };

  useEffect(() => {
    commands.setPageProperties((key?: string) => show(key));
    return () => commands.setPageProperties(null);
  }, [commands, show]);

  return (
    <div className="page-inline-properties" ref={anchorRef}>
      {page.properties.some((entry) => isGenericProperty(entry.key)) && (
        <div className="prop-strip">
          {page.properties
            .filter((entry) => isGenericProperty(entry.key))
            .slice(0, STRIP_LIMIT)
            .map((field) => (
              <button
                key={field.key}
                className="prop-strip-chip"
                data-testid={`prop-${field.key}`}
                title={`${field.key}: ${describeField(field, state, message)}`}
                onClick={(event) => show(field.key, event.currentTarget)}
              >
                {propertyGlyph(field.key, field.value_type)}
                <span className="key">{propertyDisplayName(field.key, message)}</span>
                <span className="value">{describeField(field, state, message)}</span>
              </button>
            ))}
          {page.properties.filter((entry) => isGenericProperty(entry.key)).length > STRIP_LIMIT && (
            <button
              className="prop-strip-chip"
              onClick={(event) => show(undefined, event.currentTarget)}
            >
              {message("properties.more", {
                count:
                  page.properties.filter((entry) => isGenericProperty(entry.key)).length -
                  STRIP_LIMIT,
              })}
            </button>
          )}
        </div>
      )}
      {open && (
        <PropertyPicker
          key={`${page.id}:${initialKey ?? "new"}`}
          target={{ kind: "page", id: page.id, bag: page.properties }}
          anchor={pickerAnchor.current ?? elementAnchor(anchorRef.current)}
          initialKey={initialKey}
          onClose={close}
        />
      )}
    </div>
  );
}

function describe(
  value: PropertyValue,
  state: SessionState,
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

function describeField(
  field: PropertyField,
  state: SessionState,
  message: ReturnType<typeof useI18n>["message"],
): string {
  return field.values.length === 0
    ? message("properties.noValue")
    : field.values.map((value) => describe(value, state, message)).join(", ");
}
