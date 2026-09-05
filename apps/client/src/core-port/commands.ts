import type { Command, CommandEnvelope } from "../generated/domain";
import { randomUUID } from "@/lib/crypto";

export type {
  Command,
  CommandEnvelope,
  CommandResult,
  HistoryEffect,
  InlineContent,
  BlockContentSplice,
  PropertyChange,
  SplitPlacement,
  EntityId as EntityRef,
  PropertyOwner as PropertyOwnerRef,
  QueryOwner as QueryOwnerRef,
} from "../generated/domain";

export function envelope(graphId: string, command: Command): CommandEnvelope {
  return { graph_id: graphId, command_id: randomUUID(), command };
}
