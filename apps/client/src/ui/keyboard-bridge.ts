// A phone shows its keyboard only for a field focused inside the tap itself.
// A block a tap creates arrives after a round trip to the core, too late to
// count. So the tap focuses a stand-in field at once, and the keyboard it
// raises stays up as focus moves on to the real editor; a stand-in nobody
// replaces lets the keyboard go again.

const RELEASE_MS = 1000;

let bridge: HTMLTextAreaElement | null = null;

/** Raise the keyboard now for a text field that a later render will focus. */
export function holdKeyboard(): void {
  if (!bridge) {
    bridge = document.createElement("textarea");
    bridge.setAttribute("aria-hidden", "true");
    bridge.tabIndex = -1;
    bridge.className = "keyboard-bridge";
    bridge.addEventListener("blur", () => bridge?.remove());
  }
  const field = bridge;
  document.body.append(field);
  field.focus({ preventScroll: true });
  setTimeout(() => {
    if (document.activeElement === field) field.blur();
  }, RELEASE_MS);
}
