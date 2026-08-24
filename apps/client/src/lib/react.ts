import { useCallback, useRef, useState, type SetStateAction } from "react";

/** A render-time value read later by an effect or browser callback. */
export function useLatest<T>(value: T) {
  const current = useRef(value);
  current.current = value;
  return current;
}

/** React state whose current value is also available within the same browser event. */
export function useImmediateState<T>(initial: T | (() => T)) {
  const [value, setValue] = useState(initial);
  const current = useRef(value);
  const set = useCallback((update: SetStateAction<T>) => {
    const next = typeof update === "function"
      ? (update as (previous: T) => T)(current.current)
      : update;
    current.current = next;
    setValue(next);
  }, []);
  return [value, set, current] as const;
}
