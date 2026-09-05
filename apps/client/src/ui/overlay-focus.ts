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
  owner.focus({ preventScroll: true });
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
