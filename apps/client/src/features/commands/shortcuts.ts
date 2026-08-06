// The binding table: which keys reach the global command layer, what they are
// called on screen, and what the user is allowed to change them to.
//
// Every global binding carries ⌘ (or ⌃) and that is expressed in the type rather
// than in a check — `Binding` has no `mod` field because a binding without one is
// not representable. That is the same invariant the arbitration order relies on
// (see `keys.ts`): no bare key may ever be taken from a text field, so no bare
// key may ever be bound.
//
// Bindings are stored as `event.key`, not `event.code`. `code` is stable across
// keyboard layouts; `key` is what is printed on the key the user actually pressed
// and therefore the only thing that can be shown back to them truthfully. On a
// non-QWERTY layout that means a rebound shortcut follows the character, not the
// physical position — which is the behaviour a user who chose that layout expects.

import { useMemo, useSyncExternalStore } from "react";
import {
  appSettings,
  subscribeAppSettings,
  updateAppSettings,
} from "../../entities/settings";
import type { MessageKey } from "../../i18n";
import { APPLE, MOD, isComposing } from "./keys";

export type ShortcutId =
  | "palette"
  | "properties"
  | "shortcuts"
  | "sidebar"
  | "settings"
  | "undo"
  | "redo";

export const SHORTCUT_IDS: ShortcutId[] = [
  "palette",
  "properties",
  "shortcuts",
  "sidebar",
  "settings",
  "undo",
  "redo",
];

/**
 * What each binding is called. One table, so the ⌘/ sheet, the settings editor
 * and the palette cannot disagree about the name of a verb.
 */
export const SHORTCUT_MESSAGE = {
  palette: "shortcuts.search",
  properties: "shortcuts.properties",
  shortcuts: "shortcuts.keyboard",
  sidebar: "shortcuts.sidebar",
  settings: "shortcuts.settings",
  undo: "shortcuts.undo",
  redo: "shortcuts.redo",
} as const satisfies Record<ShortcutId, MessageKey>;

export interface Binding {
  /** `event.key`, lower-cased for single characters. ⌘/⌃ is always implied. */
  key: string;
  shift: boolean;
  alt: boolean;
}

/**
 * The shipped table. `⇧⌘Z` is redo on every platform because it is the one form
 * both conventions accept; a Windows user who wants `Ctrl+Y` can now simply say
 * so, which is the point of making the table editable.
 */
export const DEFAULT_BINDINGS: Record<ShortcutId, Binding> = {
  palette: { key: "k", shift: false, alt: false },
  properties: { key: "p", shift: false, alt: false },
  shortcuts: { key: "/", shift: false, alt: false },
  sidebar: { key: "\\", shift: false, alt: false },
  settings: { key: ",", shift: false, alt: false },
  undo: { key: "z", shift: false, alt: false },
  redo: { key: "z", shift: true, alt: false },
};

export function serializeBinding(binding: Binding): string {
  return [
    "mod",
    ...(binding.shift ? ["shift"] : []),
    ...(binding.alt ? ["alt"] : []),
    binding.key,
  ].join("+");
}

export function parseBinding(value: unknown): Binding | null {
  if (typeof value !== "string") return null;
  const parts = value.split("+");
  const key = parts.pop();
  if (!key || !parts.includes("mod")) return null;
  const known = new Set(["mod", "shift", "alt"]);
  if (parts.some((part) => !known.has(part))) return null;
  return { key, shift: parts.includes("shift"), alt: parts.includes("alt") };
}

function applyOverrides(
  stored: Record<string, string> | undefined,
): Record<ShortcutId, Binding> {
  const resolved = { ...DEFAULT_BINDINGS };
  for (const id of SHORTCUT_IDS) {
    const override = parseBinding(stored?.[id]);
    if (override) resolved[id] = override;
  }
  return resolved;
}

/** Bindings in effect: the defaults with any stored override applied. */
export function resolveBindings(): Record<ShortcutId, Binding> {
  return applyOverrides(appSettings().shortcuts);
}

/**
 * React view of the table. Memoized on the stored overrides rather than rebuilt
 * per render: the shell installs its window keydown listener from this object,
 * and a fresh identity on every render would tear that listener down and re-add
 * it on every keystroke. Re-renders when another tab edits a binding too.
 */
export function useShortcutBindings(): Record<ShortcutId, Binding> {
  const settings = useSyncExternalStore(subscribeAppSettings, appSettings, appSettings);
  return useMemo(() => applyOverrides(settings.shortcuts), [settings.shortcuts]);
}

export function setBinding(id: ShortcutId, binding: Binding): void {
  const stored = { ...(appSettings().shortcuts ?? {}) };
  if (serializeBinding(binding) === serializeBinding(DEFAULT_BINDINGS[id])) delete stored[id];
  else stored[id] = serializeBinding(binding);
  updateAppSettings({ shortcuts: Object.keys(stored).length > 0 ? stored : undefined });
}

export function resetBinding(id: ShortcutId): void {
  const stored = { ...(appSettings().shortcuts ?? {}) };
  delete stored[id];
  updateAppSettings({ shortcuts: Object.keys(stored).length > 0 ? stored : undefined });
}

export function resetAllBindings(): void {
  updateAppSettings({ shortcuts: undefined });
}

export function isDefaultBinding(id: ShortcutId, binding: Binding): boolean {
  return serializeBinding(binding) === serializeBinding(DEFAULT_BINDINGS[id]);
}

/**
 * Two kinds of combination the user may not take.
 *
 * The first the browser or the operating system claims before the page ever sees
 * it, so storing one would record a shortcut that can never fire. The second the
 * *text field* claims: select-all, cut, copy, paste. Those do reach the page, and
 * the global layer would happily `preventDefault` them — which means one bad
 * rebinding could take copy and paste away from every input in the product. Both
 * are refused for the same reason: a binding must be able to work, and must not
 * cost the user something they already had.
 */
const RESERVED = new Set([
  // the browser's
  "mod+w",
  "mod+shift+w",
  "mod+t",
  "mod+shift+t",
  "mod+n",
  "mod+shift+n",
  "mod+q",
  "mod+r",
  "mod+shift+r",
  "mod+l",
  "mod+shift+i",
  "mod+alt+i",
  "mod+f",
  "mod+s",
  "mod+o",
  // every text field's
  "mod+a",
  "mod+c",
  "mod+v",
  "mod+shift+v",
  "mod+x",
]);

/** Keys that cannot carry a binding: modifiers themselves, and the keys overlays own. */
const UNBINDABLE = new Set([
  "shift",
  "control",
  "alt",
  "meta",
  "capslock",
  "altgraph",
  "dead",
  "unidentified",
  "tab",
  "escape",
  "enter",
  " ",
]);

export type BindingRejection =
  | { reason: "modifier" }
  | { reason: "key" }
  /** Carries what was pressed, so the report can name it back to the user. */
  | { reason: "reserved"; attempt: Binding };

/**
 * Reads a candidate binding out of a keydown, or explains why the key press
 * cannot become one. A rejection is always specific: "that combination belongs
 * to the browser" and "that is already Properties" are different problems.
 */
export function bindingFromEvent(
  event: KeyboardEvent | React.KeyboardEvent,
): Binding | BindingRejection {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  if (isComposing(native)) return { reason: "key" };
  const key = native.key.toLowerCase();
  if (UNBINDABLE.has(key)) return { reason: "key" };
  if (!native.metaKey && !native.ctrlKey) return { reason: "modifier" };
  const binding: Binding = { key, shift: native.shiftKey, alt: native.altKey };
  if (RESERVED.has(serializeBinding(binding))) return { reason: "reserved", attempt: binding };
  return binding;
}

export function isRejection(value: Binding | BindingRejection): value is BindingRejection {
  return "reason" in value;
}

/** The other action already holding this binding, if any. */
export function conflictingAction(
  id: ShortcutId,
  binding: Binding,
  bindings: Record<ShortcutId, Binding>,
): ShortcutId | null {
  const serialized = serializeBinding(binding);
  for (const other of SHORTCUT_IDS) {
    if (other === id) continue;
    if (serializeBinding(bindings[other]) === serialized) return other;
  }
  return null;
}

const GLYPHS: Record<string, string> = {
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  backspace: "⌫",
  delete: "⌦",
  home: "↖",
  end: "↘",
  pageup: "⇞",
  pagedown: "⇟",
};

/**
 * The display form, split into the parts a badge lays out as separate columns.
 *
 * A modifier and the key it modifies never line up when they are set as one run
 * of text — they come from different parts of a system face, and with no
 * separator `⌘K` reads as a single four-stroke glyph. So the display form is a
 * sequence, and `<Kbd>` gives each part its own column and a real gap.
 *
 * Joining the parts reproduces `formatBinding` character for character, which is
 * what keeps a rendered badge and an `aria-keyshortcuts` value from disagreeing.
 * Apple keyboards print modifiers as glyphs with no separator; everywhere else
 * they are words joined by `+`, and there the `+` is one of the parts (as
 * punctuation, which `<Kbd>` styles accordingly) rather than a join.
 */
export function formatBindingParts(binding: Binding): string[] {
  const key = GLYPHS[binding.key] ?? (binding.key.length === 1
    ? binding.key.toUpperCase()
    : binding.key.replace(/^f(\d+)$/, "F$1"));
  const keys = [
    MOD,
    ...(binding.alt ? [APPLE ? "⌥" : "Alt"] : []),
    ...(binding.shift ? [APPLE ? "⇧" : "Shift"] : []),
    key,
  ];
  if (APPLE) return keys;
  return keys.flatMap((part, index) => (index === 0 ? [part] : ["+", part]));
}

/** The display form as one string: an accessible name, a tooltip, a message. */
export function formatBinding(binding: Binding): string {
  return formatBindingParts(binding).join("");
}

export interface ShortcutHandler {
  binding: Binding;
  run(event: KeyboardEvent): void;
}

/**
 * Matches a keydown against a binding table. The caller owns `preventDefault`
 * so the decision stays visible at the call site.
 */
export function matchShortcut(
  event: KeyboardEvent,
  handlers: readonly ShortcutHandler[],
): ShortcutHandler | null {
  if (isComposing(event) || event.defaultPrevented) return null;
  if (!event.metaKey && !event.ctrlKey) return null;
  const key = event.key.toLowerCase();
  for (const handler of handlers) {
    if (handler.binding.key !== key) continue;
    if (handler.binding.shift !== event.shiftKey) continue;
    if (handler.binding.alt !== event.altKey) continue;
    return handler;
  }
  return null;
}

/** True when this keydown is exactly `binding`. Used by the outline's own editor. */
export function bindingMatches(
  event: React.KeyboardEvent | KeyboardEvent,
  binding: Binding,
): boolean {
  const native = "nativeEvent" in event ? event.nativeEvent : event;
  if (!native.metaKey && !native.ctrlKey) return false;
  return (
    native.key.toLowerCase() === binding.key &&
    native.shiftKey === binding.shift &&
    native.altKey === binding.alt
  );
}
