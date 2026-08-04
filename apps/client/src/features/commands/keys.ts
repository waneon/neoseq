// Global key handling: one listener, one arbitration order.
//
// Order is fixed and the first two steps are non-negotiable:
//   1. IME guard. A composition in progress owns the keyboard outright — losing
//      a keystroke mid-composition corrupts Korean, Japanese and Chinese input.
//   2. Already handled. Anything that called preventDefault (the outline's own
//      editor bindings, an open overlay) has already won.
//   3. Global bindings — and ONLY bindings that carry ⌘ or ⌃, so no bare key can
//      ever be stolen from a text field.

export interface KeyBinding {
  /** `event.key` compared case-insensitively. */
  key: string;
  shift?: boolean;
  run(event: KeyboardEvent): void;
}

export function isComposing(event: KeyboardEvent): boolean {
  // keyCode 229 is the "processing key" some IMEs report instead of isComposing.
  return event.isComposing || event.keyCode === 229;
}

export function isTextEntry(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

/**
 * Matches a keydown against a global binding table. Returns the binding that
 * fired, or null. Callers own preventDefault so the decision stays visible at
 * the call site.
 */
export function matchGlobal(
  event: KeyboardEvent,
  bindings: KeyBinding[],
): KeyBinding | null {
  if (isComposing(event) || event.defaultPrevented) return null;
  // The modifier requirement is what makes this layer safe to run while a text
  // field has focus.
  if (!event.metaKey && !event.ctrlKey) return null;
  const key = event.key.toLowerCase();
  for (const binding of bindings) {
    if (binding.key !== key) continue;
    if ((binding.shift ?? false) !== event.shiftKey) continue;
    return binding;
  }
  return null;
}

/** Platform-appropriate display form, so hints match the user's keyboard. */
export const MOD = typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform)
  ? "⌘"
  : "Ctrl";
