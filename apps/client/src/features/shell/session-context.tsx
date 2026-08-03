import { createContext, useContext, useSyncExternalStore } from "react";
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
