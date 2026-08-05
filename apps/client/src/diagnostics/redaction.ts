import type { Command } from "../core-port/commands";
import type { SparqlQueryRequest } from "../generated/core-port";
import type { DiagnosticAttributes, LengthBucket } from "./types";

const WELL_KNOWN_KEYS = new Set([
  "journal.date",
  "page.kind",
  "query.language",
  "query.source",
  "system.created-at",
  "system.deleted-at",
  "system.updated-at",
  "task.deadline",
  "task.priority",
  "task.scheduled",
  "task.status",
]);

export function lengthBucket(length: number): LengthBucket {
  if (length <= 0) return "0";
  if (length <= 16) return "1-16";
  if (length <= 64) return "17-64";
  if (length <= 256) return "65-256";
  if (length <= 1_024) return "257-1024";
  return "1025+";
}

export function commandAttributes(command: Command): DiagnosticAttributes {
  const base: DiagnosticAttributes = { command_type: command.type };
  switch (command.type) {
    case "ensure_page":
    case "rename_page":
      return { ...base, entity_kind: "page", text_length: lengthBucket(command.title.length) };
    case "ensure_journal":
    case "delete_page":
    case "restore_page":
      return { ...base, entity_kind: "page" };
    case "ensure_tag":
    case "rename_tag":
      return { ...base, entity_kind: "tag", text_length: lengthBucket(command.name.length) };
    case "delete_tag":
    case "restore_tag":
      return { ...base, entity_kind: "tag" };
    case "insert_block":
    case "edit_markdown":
      return { ...base, entity_kind: "block", text_length: lengthBucket(command.markdown.length) };
    case "insert_outline":
      return {
        ...base,
        entity_kind: "block",
        requested_target_count: command.items.length,
        text_length: lengthBucket(
          command.items.reduce((total, item) => total + item.markdown.length, 0),
        ),
      };
    case "splice_markdown":
      return {
        ...base,
        entity_kind: "block",
        insert_length: lengthBucket(command.insert.length),
        delete_length: lengthBucket(command.delete),
      };
    case "move_blocks":
    case "indent_blocks":
    case "outdent_blocks":
    case "delete_blocks":
      return {
        ...base,
        entity_kind: "block",
        requested_target_count: command.block_ids.length,
      };
    case "set_property":
    case "remove_property":
    case "add_repeated_property":
    case "remove_repeated_property":
      return {
        ...base,
        entity_kind: command.entity.kind,
        property_kind: WELL_KNOWN_KEYS.has(command.key) ? "well_known" : "custom",
      };
    case "set_tag_default":
    case "remove_tag_default":
      return {
        ...base,
        entity_kind: "tag",
        property_kind: WELL_KNOWN_KEYS.has(command.key) ? "well_known" : "custom",
      };
    case "add_tag":
    case "remove_tag":
      return { ...base, entity_kind: command.entity.kind };
    case "undo":
    case "redo":
      return { ...base, entity_kind: "graph" };
  }
}

export function queryAttributes(query: SparqlQueryRequest): DiagnosticAttributes {
  return {
    operation: query.language,
    source_length: lengthBucket(query.source.length),
    binding_count: Object.keys(query.bindings ?? {}).length,
  };
}
