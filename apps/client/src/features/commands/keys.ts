// Global key handling: one listener, one arbitration order.
//
// Order is fixed and the first two steps are non-negotiable:
//   1. IME guard. A composition in progress owns the keyboard outright — losing
//      a keystroke mid-composition corrupts Korean, Japanese and Chinese input.
//   2. Already handled. Anything that called preventDefault (the outline's own
//      editor bindings, an open overlay) has already won.
//   3. Global bindings — and ONLY bindings that carry ⌘ or ⌃, so no bare key can
//      ever be stolen from a text field. That invariant lives in the `Binding`
//      type in `shortcuts.ts`, which cannot express a modifier-less binding.

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

/** Whether the modifier convention and glyph set are Apple's. */
export const APPLE =
  typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform);

/** Platform-appropriate display form, so hints match the user's keyboard. */
export const MOD = APPLE ? "⌘" : "Ctrl";
