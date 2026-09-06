import { useLayoutEffect, type RefObject } from "react";
import { useLatest } from "../lib/react";

/** Text and available width both determine a native textarea's height. */
export function useTextAreaSize(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  hidden: boolean,
  onMeasure?: (textarea: HTMLTextAreaElement) => void,
  /** Wrapping or insets can change without a new value or outer box width. */
  layoutKey?: string,
) {
  const afterMeasure = useLatest(onMeasure);
  useLayoutEffect(() => {
    const textarea = ref.current;
    if (!textarea || hidden) return;
    const measure = () => {
      textarea.style.height = "0";
      // CSS owns minimum line height and any surface-specific maximum. Native
      // scrollHeight includes the padding and the line breaks at the new width.
      textarea.style.height = `${textarea.scrollHeight}px`;
      afterMeasure.current?.(textarea);
    };
    let width = textarea.getBoundingClientRect().width;
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      const nextWidth = textarea.getBoundingClientRect().width;
      if (nextWidth !== width) {
        width = nextWidth;
        measure();
      } else {
        // A height constraint may change without a new text measure. Let a
        // compact query cell update its clipped indication without a resize loop.
        afterMeasure.current?.(textarea);
      }
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [afterMeasure, hidden, ref, value, layoutKey]);
}
