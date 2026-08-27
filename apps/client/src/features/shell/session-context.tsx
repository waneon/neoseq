import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useSyncExternalStore,
} from "react";
import type { GraphSession, SessionState } from "../../core-port/session";

export const SessionContext = createContext<GraphSession | null>(null);

export function useSession(): GraphSession {
  const session = useContext(SessionContext);
  if (!session) throw new Error("useSession requires a GraphShell ancestor");
  return session;
}

export function useSessionState(): SessionState {
  const session = useSession();
  return useSyncExternalStore(session.subscribe, session.getState, session.getState);
}

/**
 * Subscribes to the smallest semantic piece of a session a view actually reads.
 * GraphSession publishes one immutable state object, but save, sync, presence,
 * directories, and outlines are independent render clocks. Returning the last
 * equal selection lets React ignore publications from every other clock.
 */
export function useSessionSelector<Selection>(
  selector: (state: SessionState) => Selection,
  equal: (left: Selection, right: Selection) => boolean = Object.is,
): Selection {
  const session = useSession();
  const selectorRef = useRef(selector);
  const equalRef = useRef(equal);
  const cached = useRef<{ selection: Selection } | null>(null);
  selectorRef.current = selector;
  equalRef.current = equal;

  const getSelection = useCallback(() => {
    const selection = selectorRef.current(session.getState());
    const previous = cached.current;
    if (previous && equalRef.current(previous.selection, selection)) {
      return previous.selection;
    }
    cached.current = { selection };
    return selection;
  }, [session]);

  return useSyncExternalStore(session.subscribe, getSelection, getSelection);
}
