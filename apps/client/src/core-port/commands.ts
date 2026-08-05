// Typed builders for `domain::Command` JSON. Shapes mirror the serde
// representation (`type` tag + snake_case fields) used by `executeJson`.

import type { PropertyValue } from "./snapshot";

export type EntityRef =
  | { kind: "page"; id: string }
  | { kind: "block"; page_id: string; id: string };

export interface OutlineItemInput {
  depth: number;
  markdown: string;
}

export type Command =
  | { type: "ensure_page"; page_id: string; title: string }
  | { type: "ensure_journal"; date: string }
  | { type: "rename_page"; page_id: string; title: string }
  | { type: "delete_page"; page_id: string }
  | { type: "restore_page"; page_id: string }
  | { type: "ensure_tag"; tag_id: string; name: string }
  | { type: "rename_tag"; tag_id: string; name: string }
  | { type: "delete_tag"; tag_id: string }
  | { type: "restore_tag"; tag_id: string }
  | { type: "insert_block"; page_id: string; parent: string | null; index: number; markdown: string }
  | {
      type: "insert_outline";
      page_id: string;
      parent: string | null;
      index: number;
      replace: string | null;
      items: OutlineItemInput[];
    }
  | { type: "edit_markdown"; page_id: string; block_id: string; markdown: string }
  | { type: "splice_markdown"; page_id: string; block_id: string; index: number; delete: number; insert: string }
  | { type: "move_blocks"; block_ids: string[]; page_id: string; parent: string | null; index: number }
  | { type: "indent_blocks"; page_id: string; block_ids: string[] }
  | { type: "outdent_blocks"; page_id: string; block_ids: string[] }
  | { type: "delete_blocks"; page_id: string; block_ids: string[] }
  | { type: "set_property"; entity: EntityRef; key: string; value: PropertyValue }
  | { type: "remove_property"; entity: EntityRef; key: string }
  | { type: "add_repeated_property"; entity: EntityRef; key: string; value: PropertyValue }
  | { type: "remove_repeated_property"; entity: EntityRef; key: string; value: PropertyValue }
  | { type: "set_tag_default"; tag_id: string; key: string; value: PropertyValue }
  | { type: "remove_tag_default"; tag_id: string; key: string }
  | { type: "add_tag"; entity: EntityRef; tag_id: string }
  | { type: "remove_tag"; entity: EntityRef; tag_id: string }
  | { type: "undo" }
  | { type: "redo" };

export interface CommandEnvelope {
  graph_id: string;
  command_id: string;
  command: Command;
}

export interface CommandResult {
  command_id: string;
  created_page: string | null;
  created_block: string | null;
  created_tag: string | null;
  changed: boolean;
}

export function envelope(graphId: string, command: Command): CommandEnvelope {
  return { graph_id: graphId, command_id: crypto.randomUUID(), command };
}
