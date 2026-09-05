import type { Command } from "../../../core-port/commands";
import type { PageDirectoryEntry } from "../../../core-port/snapshot";
import { randomUUID } from "@/lib/crypto";
import type { BlockCompletionRequest, BlockPageOption } from "./BlockCompletions";
import { projectBuffer, spliceBuffer, type ContentBuffer } from "./content-buffer";
import { planPageReference } from "./inline-content";

/** Choose identity once; retry submits these semantic pieces and commands unchanged. */
export function preparePageCompletion(
  buffer: ContentBuffer,
  directory: readonly PageDirectoryEntry[],
  request: BlockCompletionRequest,
  option: BlockPageOption,
): { buffer: ContentBuffer; actions: Command[]; caret: number } {
  const pageId = option.create ? `p-${randomUUID()}` : option.id;
  const projection = projectBuffer(buffer, directory);
  const replacement = planPageReference(
    request.blockId,
    projection.markdown,
    projection.pageReferences,
    request.start,
    request.end,
    pageId,
    option.title,
  );
  const splice = replacement.plan.splice;
  return {
    buffer: spliceBuffer(buffer, splice.index, splice.delete, splice.insert),
    actions: option.create ? [{ type: "ensure_page", page_id: pageId, title: option.title }] : [],
    caret: replacement.caret,
  };
}
