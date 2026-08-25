// Turns a rejected CorePort command into something a person can read.
//
// The core speaks in codes and lowercase fragments ("this graph is opened
// read-only in this tab"). The UI owes the user a sentence that names the verb
// that failed, and the reason underneath it — never a raw code, and never a
// bare "Error".

import { CorePortFailure } from "../../core-worker";
import type { CorePortError, CorePortErrorCode } from "../../generated/core-port";
import { createLocaleRuntime, type MessageFunction, type MessageKey } from "../../i18n";
import type { ToastInput } from "./store";

/**
 * Durability belongs to the save slot, permanently and by design
 * (designs/interaction.md § Feedback and System State). These two codes mean "applied, not yet on disk",
 * which the top bar is already stating with a dot, a reason, and Retry —
 * so the toast layer stays quiet rather than reporting one failure twice.
 */
const SAVE_SLOT_OWNS: ReadonlySet<CorePortErrorCode> = new Set([
  "dirty_unsaved",
  "storage_full",
]);
const DEFAULT_MESSAGE = createLocaleRuntime("en").message;

/** Used only when the core sends a code with no message of its own. */
const FALLBACK = {
  unsupported_contract: "error.unsupportedContract",
  invalid_request: "error.invalidRequest",
  invalid_archive: "error.invalidArchive",
  unsupported_archive: "error.unsupportedArchive",
  archive_too_large: "error.archiveTooLarge",
  archive_checksum_mismatch: "error.archiveChecksumMismatch",
  graph_not_open: "error.graphNotOpen",
  graph_already_open: "error.graphAlreadyOpen",
  graph_already_exists: "error.graphAlreadyExists",
  wrong_graph: "error.wrongGraph",
  command_timeout: "error.commandTimeout",
  invalid_query: "error.invalidQuery",
  query_budget_exceeded: "error.queryBudgetExceeded",
  dirty_unsaved: "error.unsaved",
  resync_required: "error.resyncRequired",
  unsupported_schema: "error.unsupportedSchema",
  storage_busy: "error.storageBusy",
  storage_full: "error.storageFull",
  storage_corrupt: "error.storageCorrupt",
  internal: "error.internal",
} as const satisfies Record<CorePortErrorCode, MessageKey>;

function portError(error: unknown): CorePortError | null {
  return error instanceof CorePortFailure ? error.detail : null;
}

/**
 * Builds the toast for a rejected command, or `null` when another surface owns
 * the failure. `summary` names the verb from the user's side — "Couldn't move
 * that block" — because "invalid_request" tells them nothing they can act on.
 */
export function failureToast(
  summary: string,
  error: unknown,
  message: MessageFunction = DEFAULT_MESSAGE,
): ToastInput | null {
  const detail = portError(error);
  if (detail && SAVE_SLOT_OWNS.has(detail.code)) return null;
  const code = detail?.code ?? "internal";
  return {
    tone: "danger",
    title: summary,
    detail: reasonFor(detail, message),
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
export function failureReason(
  error: unknown,
  message: MessageFunction = DEFAULT_MESSAGE,
): string {
  return reasonFor(portError(error), message);
}

function reasonFor(detail: CorePortError | null, message: MessageFunction): string {
  const diagnostic = detail?.message.toLowerCase() ?? "";
  if (diagnostic.includes("first sibling cannot be indented")) {
    return message("error.firstSiblingIndent");
  }
  if (diagnostic.includes("root block cannot be outdented")) {
    return message("error.rootBlockOutdent");
  }
  if (diagnostic.includes("page name already exists")) {
    return message("error.pageNameConflict");
  }
  if (diagnostic.includes("tag name already exists")) {
    return message("error.tagNameConflict");
  }
  return message(FALLBACK[detail?.code ?? "internal"]);
}
