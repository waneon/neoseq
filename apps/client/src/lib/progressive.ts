import { useLayoutEffect, useRef, useState } from "react";

/** Keeps a collection complete while bounding the DOM created in one frame. */
export function useProgressiveItems<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
  windowSize: number,
  pinnedKey?: string,
) {
  const source = useRef(items);
  const changed = source.current !== items;
  if (changed) source.current = items;
  const [limit, setLimit] = useState(windowSize);

  useLayoutEffect(() => {
    if (changed) setLimit(windowSize);
  }, [changed, items, windowSize]);

  const effectiveLimit = changed ? windowSize : limit;
  const visible = items.slice(0, effectiveLimit);
  if (pinnedKey && !visible.some((item) => keyOf(item) === pinnedKey)) {
    const pinned = items.find((item) => keyOf(item) === pinnedKey);
    if (pinned) visible.push(pinned);
  }

  return {
    items: visible,
    remaining: Math.max(0, items.length - effectiveLimit),
    showMore: () => setLimit((current) => Math.min(items.length, current + windowSize)),
  };
}
