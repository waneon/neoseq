// Typed builders for `domain::Command` JSON. Shapes mirror the serde
// representation (`type` tag + snake_case fields) used by `executeJson`.

import type {
  PropertyValue,
  PropertyValueType,
  PropertyDocument,
  QueryPlanDocument,
  QueryView,
  OutlineOwner,
} from "./snapshot";
import type { OutlineFragment } from "./fragment";
import { randomUUID } from "@/lib/crypto";

export type EntityRef =
  | { kind: "page"; id: string }
  | { kind: "block"; owner: OutlineOwner; id: string };

export type PropertyOwnerRef =
  | { kind: "page"; id: string }
  | { kind: "block"; owner: OutlineOwner; id: string }
  /** The tag itself — where its query lives. */
  | { kind: "tag"; tag_id: string }
  /** What the tag copies onto whatever it is added to. */
  | { kind: "tag_default"; tag_id: string };

export type QueryOwnerRef =
  | { kind: "page"; id: string }
  | { kind: "block"; owner: OutlineOwner; id: string }
  | { kind: "tag"; tag_id: string }
  | { kind: "graph_default"; default_query_id: string };

interface OutlineItemInput {
  depth: number;
  markdown: string;
}

export type SplitPlacement = "before" | "after" | "first_child";

export interface PropertyChange {
  key: string;
  /** `null` removes the complete field. */
  value: PropertyValue | null;
}

export type InlineContent =
  | { type: "markdown"; value: string }
  | { type: "page_reference"; page_id: string };

export interface BlockContentSplice {
  block_id: string;
  index: number;
  delete: number;
  insert: InlineContent[];
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
  | {
      type: "insert_block";
      owner: OutlineOwner;
      parent: string | null;
      index: number;
      markdown: string;
    }
  | {
      type: "split_block";
      owner: OutlineOwner;
      block_id: string;
      index: number;
      placement: SplitPlacement;
    }
  | { type: "merge_block_backward"; owner: OutlineOwner; block_id: string }
  | {
      type: "insert_outline";
      owner: OutlineOwner;
      parent: string | null;
      index: number;
      replace: string | null;
      items: OutlineItemInput[];
    }
  | {
      type: "paste_outline";
      owner: OutlineOwner;
      parent: string | null;
      index: number;
      replace: string | null;
      fragment: OutlineFragment;
    }
  | { type: "edit_markdown"; owner: OutlineOwner; block_id: string; markdown: string }
  | {
      type: "splice_markdown";
      owner: OutlineOwner;
      block_id: string;
      index: number;
      delete: number;
      insert: string;
    }
  | {
      type: "splice_markdowns";
      owner: OutlineOwner;
      splices: Array<{ block_id: string; index: number; delete: number; insert: string }>;
    }
  | ({ type: "splice_block_content"; owner: OutlineOwner } & BlockContentSplice)
  | {
      type: "splice_block_contents";
      owner: OutlineOwner;
      splices: BlockContentSplice[];
    }
  | {
      type: "move_blocks";
      block_ids: string[];
      owner: OutlineOwner;
      parent: string | null;
      after: string | null;
    }
  | { type: "indent_blocks"; owner: OutlineOwner; block_ids: string[] }
  | { type: "outdent_blocks"; owner: OutlineOwner; block_ids: string[] }
  | { type: "delete_blocks"; owner: OutlineOwner; block_ids: string[] }
  | {
      type: "ensure_property";
      owner: PropertyOwnerRef;
      key: string;
      value_type: PropertyValueType;
      cardinality: "single" | "set";
    }
  | { type: "set_property"; owner: PropertyOwnerRef; key: string; value: PropertyValue }
  | { type: "set_properties"; owner: PropertyOwnerRef; changes: PropertyChange[] }
  | { type: "clear_property_values"; owner: PropertyOwnerRef; key: string }
  | { type: "remove_property"; owner: PropertyOwnerRef; key: string }
  | { type: "add_repeated_property"; owner: PropertyOwnerRef; key: string; value: PropertyValue }
  | { type: "remove_repeated_property"; owner: PropertyOwnerRef; key: string; value: PropertyValue }
  | {
      type: "create_default_query";
      default_query_id: string;
      title: string;
      document: PropertyDocument;
    }
  | { type: "rename_default_query"; default_query_id: string; title: string }
  | { type: "move_default_query"; default_query_id: string; index: number }
  | { type: "delete_default_query"; default_query_id: string }
  | { type: "set_query_source"; owner: QueryOwnerRef; view_id: string; source: string }
  | {
      type: "splice_query_source";
      owner: QueryOwnerRef;
      view_id: string;
      index: number;
      delete: number;
      insert: string;
    }
  | {
      type: "set_query_plan";
      owner: QueryOwnerRef;
      view_id: string;
      plan: QueryPlanDocument;
      source: string;
    }
  | { type: "clear_query_plan"; owner: QueryOwnerRef; view_id: string }
  | { type: "put_query_view"; owner: QueryOwnerRef; view: QueryView }
  | { type: "remove_query_view"; owner: QueryOwnerRef; view_id: string }
  | { type: "set_query_default_view"; owner: QueryOwnerRef; view_id: string }
  | { type: "add_tag"; entity: EntityRef; tag_id: string }
  | { type: "remove_tag"; entity: EntityRef; tag_id: string }
  | { type: "batch"; commands: Command[] }
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
  scope: "entity" | "outline" | "graph";
  affected_outlines: OutlineOwner[];
  reveal: EntityRef | null;
}

export function envelope(graphId: string, command: Command): CommandEnvelope {
  return { graph_id: graphId, command_id: randomUUID(), command };
}
