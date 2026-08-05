// Turns a rejected CorePort command into something a person can read.
//
// The core speaks in codes and lowercase fragments ("this graph is opened
// read-only in this tab"). The UI owes the user a sentence that names the verb
// that failed, and the reason underneath it — never a raw code, and never a
// bare "Error".

import { CorePortFailure } from "../../core-worker";
import type { CorePortError, CorePortErrorCode } from "../../generated/core-port";
import type { ToastInput } from "./store";

/**
 * Durability belongs to the save slot, permanently and by design
 * (DESIGN.md § Save slot). These two codes mean "applied, not yet on disk",
 * which the top bar is already stating with a dot, a reason, and Retry —
 * so the toast layer stays quiet rather than reporting one failure twice.
 */
const SAVE_SLOT_OWNS: ReadonlySet<CorePortErrorCode> = new Set([
  "dirty_unsaved",
  "storage_full",
]);

/** Used only when the core sends a code with no message of its own. */
const FALLBACK: Record<CorePortErrorCode, string> = {
  unsupported_contract: "This version of the app cannot talk to that graph.",
  invalid_request: "The change was rejected as invalid.",
  graph_not_open: "The graph is no longer open.",
  graph_already_open: "That graph is already open.",
  wrong_graph: "That change belongs to a different graph.",
  command_timeout: "The change took too long and was abandoned.",
  invalid_query: "The query could not be read.",
  query_budget_exceeded: "The query was too expensive to finish.",
  dirty_unsaved: "The change is not on disk yet.",
  resync_required: "This tab fell behind and needs to reload.",
  unsupported_schema: "This graph was written by a newer version of NeoSeq.",
  storage_busy: "Local storage is busy.",
  storage_full: "Local storage is full.",
  storage_corrupt: "Some stored data is damaged.",
  internal: "Something went wrong inside the graph engine.",
};

const MAX_DETAIL = 220;

export function portError(error: unknown): CorePortError | null {
  return error instanceof CorePortFailure ? error.detail : null;
}

/**
 * Builds the toast for a rejected command, or `null` when another surface owns
 * the failure. `summary` names the verb from the user's side — "Couldn't move
 * that block" — because "invalid_request" tells them nothing they can act on.
 */
export function failureToast(summary: string, error: unknown): ToastInput | null {
  const detail = portError(error);
  if (detail && SAVE_SLOT_OWNS.has(detail.code)) return null;
  const code = detail?.code ?? "internal";
  return {
    tone: "danger",
    title: summary,
    detail: reasonFor(detail, error),
    // The same verb failing the same way collapses onto one toast, so a held
    // key or a retry loop cannot bury the screen in identical copies.
    key: `${summary} ${code}`,
  };
}

/**
 * The reason on its own, for the few reports that write their own title —
 * a failure whose consequence (dropped rows, lost keystrokes) needs saying
 * before the cause does.
 */
export function failureReason(error: unknown): string {
  return reasonFor(portError(error), error);
}

function reasonFor(detail: CorePortError | null, error: unknown): string {
  const raw = detail?.message ?? (error instanceof Error ? error.message : "");
  const text = raw.replace(/\s+/gu, " ").trim();
  if (text.length === 0) return FALLBACK[detail?.code ?? "internal"];
  return clamp(asSentence(text));
}

function asSentence(text: string): string {
  const capitalised = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?…]$/u.test(capitalised) ? capitalised : `${capitalised}.`;
}

function clamp(text: string): string {
  if (text.length <= MAX_DETAIL) return text;
  return `${text.slice(0, MAX_DETAIL - 1).trimEnd()}…`;
}
