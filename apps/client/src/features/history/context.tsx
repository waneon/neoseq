import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router";
import type { CommandResult, EntityRef } from "../../core-port/commands";
import type { QueryEntityRef } from "../../generated/core-port";
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
  /**
   * Opens one entity, wherever it lives: the page it is on, then the block
   * itself. Undo/redo is one caller; following a query result is another, and
   * both need the same "navigate, then let the mounted outliner reveal" order.
   */
  reveal(target: EntityRef, focus?: boolean): void;
  /**
   * Opens anything the graph can name, including the one kind that is not an
   * entity in the outline's sense: a tag, which has a place of its own rather
   * than a line to be scrolled to.
   */
  open(target: QueryEntityRef): void;
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

  const reveal = useCallback((target: EntityRef, focus = false) => {
    const pageId = target.kind === "page" ? target.id : target.page_id;
    const current = revealer.current;
    if (target.kind === "page") {
      if (current?.pageId !== pageId) navigate(routeForPage(pageId));
      return;
    }
    const request: HistoryRevealRequest = {
      token: crypto.randomUUID(),
      blockId: target.id,
      focus,
    };
    if (current?.pageId === pageId && current.handler(request)) return;
    pending.current = { pageId, request };
    if (current?.pageId !== pageId) navigate(routeForPage(pageId));
  }, [navigate, routeForPage]);

  const open = useCallback((target: QueryEntityRef) => {
    if (target.kind === "tag") {
      navigate(`/g/${graphId}/t/${encodeURIComponent(target.id)}`);
      return;
    }
    reveal(target.kind === "page"
      ? { kind: "page", id: target.id }
      : { kind: "block", page_id: target.page_id, id: target.id });
  }, [graphId, navigate, reveal]);

  const run = useCallback(async (
    direction: "undo" | "redo",
    invocation: HistoryInvocation,
  ): Promise<CommandResult> => {
    const result = await session.execute({ type: direction });
    const effect = result.history_effect;
    if (!effect || effect.scope === "graph" || !effect.reveal) return result;
    reveal(effect.reveal, invocation.kind === "outline");
    return result;
  }, [reveal, session]);

  const actions = useMemo<HistoryActions>(
    () => ({ run, registerRevealer, reveal, open }),
    [open, registerRevealer, reveal, run],
  );
  return <HistoryContext.Provider value={actions}>{children}</HistoryContext.Provider>;
}

export function useHistoryActions(): HistoryActions {
  const actions = useContext(HistoryContext);
  if (!actions) throw new Error("useHistoryActions requires a HistoryProvider ancestor");
  return actions;
}
