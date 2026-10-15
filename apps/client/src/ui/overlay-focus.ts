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

/**
 * Moves focus once React has finished its commit. Blurring a field dispatches
 * events of its own — a `change`, for one — and those must not land inside
 * React's work.
 */
export function afterCommit(task: () => void): void {
  queueMicrotask(task);
}

/**
 * Returns focus once every arrival a closing surface's action set off has
 * happened, so a surface that action opened keeps the focus it took.
 */
export function afterArrivals(task: () => void): void {
  setTimeout(task, 0);
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

/**
 * Restore an overlay's owner without overriding an action's focus transfer:
 * only focus left inside the closing surface, or dropped onto the page, returns.
 */
export function restoreOverlayFocus(surface: Element | null, owner: HTMLElement | null): void {
  if (!owner?.isConnected) return;
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected && !surface?.contains(active)) {
    return;
  }
  focusOverlayOwner(owner);
}

const menuOwners = new WeakMap<Element, () => HTMLElement | null>();

/**
 * A ref naming where focus belongs once a menu is gone, for a menu whose
 * trigger is a placeholder rather than the control that summoned it.
 */
export function menuOwnerRef(owner: () => HTMLElement | null) {
  return (menu: Element | null) => {
    if (menu) menuOwners.set(menu, owner);
  };
}

export function menuFocusOwner(menu: Element | null): HTMLElement | null {
  const owner = menu && menuOwners.get(menu);
  if (owner) return owner();
  const triggerId = menu?.getAttribute("aria-labelledby");
  const trigger = triggerId ? document.getElementById(triggerId) : null;
  const popup = trigger?.getAttribute("aria-haspopup");
  return popup === "true" || popup === "menu" ? trigger : null;
}

export function currentFocusOwner(): HTMLElement | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || active === document.body) return null;

  // A selected menu item disappears as its dialog opens. The menu's semantic
  // label identifies the persistent trigger that should receive focus later.
  return menuFocusOwner(active.closest('[role="menu"]')) ?? active;
}

const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function firstTabbable(root: Element): HTMLElement | null {
  return root.querySelector<HTMLElement>(TABBABLE);
}

/** A layer's dismissal that the caller may veto with `preventDefault`. */
export interface PanelEvent {
  readonly defaultPrevented: boolean;
  preventDefault(): void;
}

export function vetoable(): PanelEvent {
  let prevented = false;
  return {
    get defaultPrevented() {
      return prevented;
    },
    preventDefault() {
      prevented = true;
    },
  };
}
