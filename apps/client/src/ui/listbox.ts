// The one keyboard for a focus-roving option list.
//
// Two listbox flavours exist in the product and they share one look and one key
// map. A list *behind an input* (the palette, the property search, the date
// editor) keeps focus in the input and moves an active index — those lists own
// their index state. A list that *is* the surface (the type chooser, an enum's
// values) parks focus on the options themselves; this helper gives its
// container ↑/↓/Home/End without every list re-implementing the walk.

/**
 * Moves focus among the container's enabled options for a navigation key.
 * Returns true when the key was one of ours (the caller prevents default).
 */
export function moveOptionFocus(container: HTMLElement, key: string): boolean {
  if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") {
    return false;
  }
  const options = [
    ...container.querySelectorAll<HTMLElement>('[role="option"]:not(:disabled)'),
  ];
  if (options.length === 0) return false;
  const current = options.indexOf(document.activeElement as HTMLElement);
  const next =
    key === "Home"
      ? 0
      : key === "End"
        ? options.length - 1
        : key === "ArrowDown"
          ? Math.min(current + 1, options.length - 1)
          : Math.max(current - 1, 0);
  options[next]?.focus({ preventScroll: false });
  options[next]?.scrollIntoView({ block: "nearest" });
  return true;
}
