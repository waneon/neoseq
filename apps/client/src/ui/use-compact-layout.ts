import { useSyncExternalStore } from "react";

const COMPACT_LAYOUT = "(max-width: 840px)";

function subscribe(onChange: () => void): () => void {
  const media = window.matchMedia(COMPACT_LAYOUT);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function useCompactLayout(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(COMPACT_LAYOUT).matches,
    () => false,
  );
}
