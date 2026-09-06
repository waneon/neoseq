const keyboardInput = new WeakMap<Document, boolean>();

/** Escape dismisses a layer without changing the input context that opened it. */
export function trackOverlayFocusInput(document: Document): () => void {
  const pointer = () => keyboardInput.set(document, false);
  const keyboard = (event: KeyboardEvent) => {
    if (
      event.isComposing ||
      ["Escape", "Shift", "Control", "Alt", "Meta", "CapsLock"].includes(event.key)
    )
      return;
    keyboardInput.set(document, true);
  };
  document.addEventListener("pointerdown", pointer, true);
  document.addEventListener("keydown", keyboard, true);
  return () => {
    document.removeEventListener("pointerdown", pointer, true);
    document.removeEventListener("keydown", keyboard, true);
    keyboardInput.delete(document);
  };
}

/** Restore native focus and its appearance together, leaving text-entry cues to the browser. */
export function focusOverlayOwner(owner: HTMLElement | null): void {
  if (!owner?.isConnected) return;
  const textEntry = owner.matches("input, textarea") || owner.isContentEditable;
  const options: FocusOptions & { focusVisible?: boolean } = {
    preventScroll: true,
    focusVisible: textEntry ? undefined : keyboardInput.get(owner.ownerDocument),
  };
  owner.focus(options);
}

/** Restore an overlay's owner without overriding an action's focus transfer. */
export function restoreOverlayFocus(event: Event, owner: HTMLElement | null): void {
  event.preventDefault();
  if (!owner?.isConnected) return;

  const active = document.activeElement;
  const surface = event.currentTarget;
  if (
    active &&
    active !== document.body &&
    active.isConnected &&
    !(surface instanceof HTMLElement && surface.contains(active))
  ) {
    return;
  }
  focusOverlayOwner(owner);
}

export function menuFocusOwner(menu: Element | null): HTMLElement | null {
  const triggerId = menu?.getAttribute("aria-labelledby");
  const trigger = triggerId ? document.getElementById(triggerId) : null;
  return trigger?.getAttribute("aria-haspopup") === "menu" ? trigger : null;
}

export function currentFocusOwner(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;

  // A selected menu item disappears as its dialog opens. The menu's semantic
  // label identifies the persistent trigger that should receive focus later.
  return menuFocusOwner(active.closest('[role="menu"]')) ?? active;
}
