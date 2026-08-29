import { useCallback, useLayoutEffect } from "react";
import { useImmediateState } from "../../../../lib/react";
import {
  initialVimState,
  interpretVimKey,
  type VimInterpretation,
  type VimKey,
  type VimMode,
  type VimSnapshot,
  type VimState,
} from "./engine";

export interface VimSession {
  state: VimState;
  interpret(snapshot: VimSnapshot, key: VimKey): VimInterpretation;
  reset(mode?: VimMode): void;
}

export function useVimSession(enabled: boolean): VimSession {
  const [state, setState, stateRef] = useImmediateState(initialVimState);

  const reset = useCallback(
    (mode: VimMode = "normal") => {
      setState(initialVimState(mode));
    },
    [setState],
  );

  // A keymap change must settle before the browser can deliver a pointer
  // activation. A passive effect could run after that click and overwrite the
  // Insert mode it just chose with this session reset.
  useLayoutEffect(() => {
    reset();
  }, [enabled, reset]);

  const interpret = useCallback(
    (snapshot: VimSnapshot, key: VimKey) => {
      const next = interpretVimKey(stateRef.current, snapshot, key);
      if (next.state !== stateRef.current) {
        setState(next.state);
      }
      return next;
    },
    [setState, stateRef],
  );

  return { state, interpret, reset };
}
