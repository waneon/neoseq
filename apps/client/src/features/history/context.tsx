import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import type { CommandResult } from "../../core-port/commands";
import type { GraphSession } from "../../core-port/session";
import { findPage, journalDate, pageKind } from "../../core-port/snapshot";

export type HistoryInvocation =
  | { kind: "outline"; pageId: string; blockId: string }
  | { kind: "global-shortcut" }
  | { kind: "palette" };

export interface HistoryRevealRequest {
  token: string;
  blockId: string;
  focus: boolean;
}

type RevealHandler = (request: HistoryRevealRequest) => boolean;

interface RegisteredRevealer {
  pageId: string;
  handler: RevealHandler;
}

interface PendingReveal {
  pageId: string;
  request: HistoryRevealRequest;
}

export interface HistoryActions {
  run(direction: "undo" | "redo", invocation: HistoryInvocation): Promise<CommandResult>;
  registerRevealer(pageId: string, handler: RevealHandler): () => void;
}

const HistoryContext = createContext<HistoryActions | null>(null);

export function HistoryProvider({
  session,
  graphId,
  children,
}: {
  session: GraphSession;
  graphId: string;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const revealer = useRef<RegisteredRevealer | null>(null);
  const pending = useRef<PendingReveal | null>(null);

  const registerRevealer = useCallback((pageId: string, handler: RevealHandler) => {
    const registration = { pageId, handler };
    revealer.current = registration;
    const request = pending.current;
    if (request?.pageId === pageId && handler(request.request)) {
      pending.current = null;
    }
    return () => {
      if (revealer.current === registration) revealer.current = null;
    };
  }, []);

  const routeForPage = useCallback((pageId: string) => {
    const page = findPage(session.getState().snapshot, pageId);
    const date = page && pageKind(page) === "journal" ? journalDate(page) : undefined;
    return date
      ? `/g/${graphId}/journal/${date}`
      : `/g/${graphId}/p/${encodeURIComponent(pageId)}`;
  }, [graphId, session]);

  const run = useCallback(async (
    direction: "undo" | "redo",
    invocation: HistoryInvocation,
  ): Promise<CommandResult> => {
    const result = await session.execute({ type: direction });
    const effect = result.history_effect;
    if (!effect || effect.scope === "graph" || !effect.reveal) return result;

    const target = effect.reveal;
    const pageId = target.kind === "page" ? target.id : target.page_id;
    const current = revealer.current;
    if (target.kind === "page") {
      if (current?.pageId !== pageId) navigate(routeForPage(pageId));
      return result;
    }

    const request: HistoryRevealRequest = {
      token: crypto.randomUUID(),
      blockId: target.id,
      focus: invocation.kind === "outline",
    };
    if (current?.pageId === pageId && current.handler(request)) return result;

    pending.current = { pageId, request };
    if (current?.pageId !== pageId) navigate(routeForPage(pageId));
    return result;
  }, [navigate, routeForPage, session]);

  const actions = useMemo<HistoryActions>(
    () => ({ run, registerRevealer }),
    [registerRevealer, run],
  );
  return <HistoryContext.Provider value={actions}>{children}</HistoryContext.Provider>;
}

export function useHistoryActions(): HistoryActions {
  const actions = useContext(HistoryContext);
  if (!actions) throw new Error("useHistoryActions requires a HistoryProvider ancestor");
  return actions;
}
