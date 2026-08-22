import type { GraphSession } from "../../core-port/session";

/**
 * Query disclosure is a reader preference, not graph data. Keep it beside the
 * graph session so a route change does not reopen an answer the reader folded,
 * while another tab, collaborator, or later graph session starts expanded.
 */
const collapsedResults = new WeakMap<GraphSession, Set<string>>();

export function queryResultsAreOpen(session: GraphSession, owner: string): boolean {
  return !collapsedResults.get(session)?.has(owner);
}

export function rememberQueryResultsOpen(
  session: GraphSession,
  owner: string,
  open: boolean,
): void {
  const collapsed = collapsedResults.get(session) ?? new Set<string>();
  if (open) collapsed.delete(owner);
  else collapsed.add(owner);
  if (collapsed.size === 0) collapsedResults.delete(session);
  else collapsedResults.set(session, collapsed);
}
