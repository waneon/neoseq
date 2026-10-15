// Input an editor still holds when its page goes away. A hidden page may be
// closed or discarded before the worker writes anything, so this record is
// written synchronously and replayed when the graph next opens writable.

import type { Command, InlineContent } from "./commands";
import type { OutlineOwner } from "./snapshot";

export type UnsavedEdit =
  /** A block's text. It applies only from one of the `bases` the editor knew,
   * so an edit that landed after all, or a block changed elsewhere, is left alone. */
  | {
      kind: "content";
      owner: OutlineOwner;
      block_id: string;
      bases: InlineContent[][];
      content: InlineContent[];
    }
  /** A command that states its final value and may be applied again. */
  | { kind: "command"; command: Command };

const VERSION = 1;

function storageKey(repositoryId: string, graphId: string): string {
  return `neoseq.unsaved.${repositoryId}.${graphId}`;
}

export function keepUnsaved(repositoryId: string, graphId: string, edits: UnsavedEdit[]): void {
  try {
    const key = storageKey(repositoryId, graphId);
    if (edits.length === 0) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify({ version: VERSION, edits }));
  } catch {
    // Storage may be full or blocked; the asynchronous save is still running.
  }
}

export function readUnsaved(repositoryId: string, graphId: string): UnsavedEdit[] {
  try {
    const raw = localStorage.getItem(storageKey(repositoryId, graphId));
    const record = raw ? (JSON.parse(raw) as { version?: number; edits?: UnsavedEdit[] }) : null;
    return record?.version === VERSION && Array.isArray(record.edits) ? record.edits : [];
  } catch {
    return [];
  }
}

export function forgetUnsaved(repositoryId: string, graphId: string): void {
  keepUnsaved(repositoryId, graphId, []);
}
