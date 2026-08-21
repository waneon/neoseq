// Typed builders for `domain::Command` JSON. Shapes mirror the serde
// representation (`type` tag + snake_case fields) used by `executeJson`.

import type {
  PropertyValue,
  PropertyValueType,
  QueryPlanDocument,
  QueryView,
} from "./snapshot";
import type { OutlineFragment } from "./fragment";

export type EntityRef =
  | { kind: "page"; id: string }
  | { kind: "block"; page_id: string; id: string };

export type PropertyOwnerRef =
  | { kind: "page"; id: string }
  | { kind: "block"; page_id: string; id: string }
  | { kind: "tag_default"; tag_id: string };

interface OutlineItemInput {
  depth: number;
  markdown: string;
}

export type SplitPlacement = "before" | "after" | "first_child";

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
  | { type: "split_block"; page_id: string; block_id: string; index: number; placement: SplitPlacement }
  | {
      type: "insert_outline";
      page_id: string;
      parent: string | null;
      index: number;
      replace: string | null;
      items: OutlineItemInput[];
    }
  | {
      type: "paste_outline";
      page_id: string;
      parent: string | null;
      index: number;
      replace: string | null;
      fragment: OutlineFragment;
    }
  | { type: "edit_markdown"; page_id: string; block_id: string; markdown: string }
  | { type: "splice_markdown"; page_id: string; block_id: string; index: number; delete: number; insert: string }
  | { type: "move_blocks"; block_ids: string[]; page_id: string; parent: string | null; index: number }
  | { type: "indent_blocks"; page_id: string; block_ids: string[] }
  | { type: "outdent_blocks"; page_id: string; block_ids: string[] }
  | { type: "delete_blocks"; page_id: string; block_ids: string[] }
  | {
      type: "ensure_property";
      owner: PropertyOwnerRef;
      key: string;
      value_type: PropertyValueType;
      cardinality: "single" | "set";
    }
  | { type: "set_property"; owner: PropertyOwnerRef; key: string; value: PropertyValue }
  | { type: "clear_property_values"; owner: PropertyOwnerRef; key: string }
  | { type: "remove_property"; owner: PropertyOwnerRef; key: string }
  | { type: "add_repeated_property"; owner: PropertyOwnerRef; key: string; value: PropertyValue }
  | { type: "remove_repeated_property"; owner: PropertyOwnerRef; key: string; value: PropertyValue }
  | { type: "set_query_source"; owner: PropertyOwnerRef; source: string }
  | { type: "splice_query_source"; owner: PropertyOwnerRef; index: number; delete: number; insert: string }
  | { type: "set_query_plan"; owner: PropertyOwnerRef; plan: QueryPlanDocument; source: string }
  | { type: "clear_query_plan"; owner: PropertyOwnerRef }
  | { type: "put_query_view"; owner: PropertyOwnerRef; view: QueryView }
  | { type: "remove_query_view"; owner: PropertyOwnerRef; view_id: string }
  | { type: "set_query_default_view"; owner: PropertyOwnerRef; view_id: string }
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
  history_effect: HistoryEffect | null;
}

export interface HistoryEffect {
  scope: "entity" | "page" | "graph";
  affected_pages: string[];
  reveal: EntityRef | null;
}

export function envelope(graphId: string, command: Command): CommandEnvelope {
  return { graph_id: graphId, command_id: crypto.randomUUID(), command };
}
