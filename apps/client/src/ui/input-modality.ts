import { useSyncExternalStore } from "react";

// How the reader reaches the app. Touch is a question of input, not of width: a
// phone held sideways and a tablet are wider than any phone layout, and still
// have no hover, no right click, and a keyboard that covers half the screen.
// Stylesheets read the same answers from `data-touch` and `data-phone` on the
// root, so a component and its CSS never disagree.

/** A coarse primary pointer: touch routes, touch targets, and touch focus policy. */
const TOUCH = "(pointer: coarse)";
/** A screen too small to anchor a popover beside its trigger: surfaces become sheets. */
const PHONE =
  "(max-width: 600px), (pointer: coarse) and (max-width: 840px), (pointer: coarse) and (max-height: 500px)";

function matches(query: string): boolean {
  return typeof window !== "undefined" && window.matchMedia(query).matches;
}

export function isTouch(): boolean {
  return matches(TOUCH);
}

export function isPhone(): boolean {
  return matches(PHONE);
}

function subscribe(query: string) {
  return (onChange: () => void) => {
    const media = window.matchMedia(query);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  };
}

const subscribeTouch = subscribe(TOUCH);
const subscribePhone = subscribe(PHONE);

export function useTouch(): boolean {
  return useSyncExternalStore(subscribeTouch, isTouch, () => false);
}

export function usePhone(): boolean {
  return useSyncExternalStore(subscribePhone, isPhone, () => false);
}

/** Mirrors the answers onto the root element for stylesheets. */
export function trackInputModality(window: Window): () => void {
  const root = window.document.documentElement;
  const touch = window.matchMedia(TOUCH);
  const phone = window.matchMedia(PHONE);
  const update = () => {
    root.toggleAttribute("data-touch", touch.matches);
    root.toggleAttribute("data-phone", phone.matches);
  };
  update();
  touch.addEventListener("change", update);
  phone.addEventListener("change", update);
  return () => {
    touch.removeEventListener("change", update);
    phone.removeEventListener("change", update);
    root.removeAttribute("data-touch");
    root.removeAttribute("data-phone");
  };
}
