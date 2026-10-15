import { useCallback, useRef, useState, type SetStateAction } from "react";

/** A render-time value read later by an effect or browser callback. */
export function useLatest<T>(value: T) {
  const current = useRef(value);
  current.current = value;
  return current;
}

/**
 * A function with one identity for the component's lifetime that always runs
 * the latest render's closure. For event handlers handed to memoized children;
 * it must not be called during render.
 */
export function useStableCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useLatest(callback);
  return useCallback((...args: Args) => latest.current(...args), [latest]);
}

/** React state whose current value is also available within the same browser event. */
export function useImmediateState<T>(initial: T | (() => T)) {
  const [value, setValue] = useState(initial);
  const current = useRef(value);
  const set = useCallback((update: SetStateAction<T>) => {
    const next =
      typeof update === "function" ? (update as (previous: T) => T)(current.current) : update;
    current.current = next;
    setValue(next);
  }, []);
  return [value, set, current] as const;
}
