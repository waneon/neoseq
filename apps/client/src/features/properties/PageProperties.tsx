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
import { elementAnchor, type Anchor } from "@/ui/anchored";
import { currentFocusOwner } from "@/ui/overlay-focus";

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
  const pickerAnchor = useRef<Anchor>(null);
  const [initialKey, setInitialKey] = useState<string | undefined>();

  const pageControl = useCallback(() => {
    const pageBody = anchorRef.current?.closest(".page-body");
    return (
      pageBody?.querySelector<HTMLElement>('[data-testid="page-title"]') ??
      pageBody?.querySelector<HTMLElement>('[data-testid="page-actions-trigger"]') ??
      null
    );
  }, []);

  const pageAnchor = useCallback((): Anchor => {
    const owner = pageControl();
    // An empty strip has no useful target. The persistent title/action control
    // supplies both geometry and a keyboard return route, including journals.
    const geometry = elementAnchor(
      anchorRef.current?.firstElementChild ? anchorRef.current : owner,
    );
    return geometry ? { ...geometry, owner } : null;
  }, [pageControl]);

  const show = useCallback(
    (key?: string, anchor?: HTMLElement) => {
      setInitialKey(key);
      const active = currentFocusOwner();
      const invokedFromPalette = Boolean(active?.closest('[data-testid="command-palette"]'));
      const owner = anchor ?? (!invokedFromPalette ? active : null) ?? pageControl();
      // The command palette disappears before this picker measures. The page strip
      // is the durable owner of this surface; a palette input is only the route that
      // summoned it, never a geometry source that may survive the transition.
      const source = anchor ? elementAnchor(anchor) : pageAnchor();
      pickerAnchor.current = source ? { ...source, owner } : null;
      onOpenChange(true);
    },
    [onOpenChange, pageAnchor, pageControl],
  );

  useEffect(() => {
    if (open) return;
    // PageView's title menu owns only the boolean disclosure state. Treat that
    // route as a fresh add/change request, never as a replay of the last row.
    setInitialKey(undefined);
    pickerAnchor.current = null;
  }, [open]);

  const close = () => {
    onOpenChange(false);
  };

  useEffect(() => {
    commands.setPageProperties((key?: string) => show(key));
    return () => commands.setPageProperties(null);
  }, [commands, show]);

  const activeAnchor = pickerAnchor.current ?? pageAnchor();

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
          target={{ owner: { kind: "page", id: page.id }, bag: page.properties }}
          anchor={activeAnchor}
          initialKey={initialKey}
          returnFocus={() => {
            const owner = activeAnchor?.owner;
            return owner?.isConnected ? owner : pageControl();
          }}
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
