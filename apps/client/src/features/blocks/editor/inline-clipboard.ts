// Text copied from inside a block keeps its page references when pasted back
// into the same graph; plain text alone would turn each one into `[[Title]]`.

import type { InlineContent } from "../../../core-port/commands";
import type { PageReferenceSpan } from "../../../core-port/snapshot";
import { bufferAtoms, inlineContent, type ContentBuffer } from "./content-buffer";
import { canonicalContentBoundary } from "./inline-content";

const INLINE_CLIPBOARD_TYPE = "application/x-neoseq-inline+json";

/** The selected atoms of a block, as a range into its buffer. */
export function inlineSelection(
  buffer: ContentBuffer,
  markdown: string,
  references: readonly PageReferenceSpan[],
  startUtf16: number,
  endUtf16: number,
): { index: number; delete: number; content: InlineContent[] } {
  const index = canonicalContentBoundary(markdown, references, startUtf16).index;
  const end = canonicalContentBoundary(markdown, references, endUtf16).index;
  return {
    index,
    delete: end - index,
    content: inlineContent(bufferAtoms(buffer).slice(index, end)),
  };
}

/** Writes a selection that holds a reference; plain text is the browser's own. */
export function writeInlineClipboard(
  clipboard: DataTransfer,
  graphId: string,
  text: string,
  content: readonly InlineContent[],
): boolean {
  if (!content.some((item) => item.type === "page_reference")) return false;
  clipboard.setData("text/plain", text);
  clipboard.setData(INLINE_CLIPBOARD_TYPE, JSON.stringify({ graph_id: graphId, content }));
  return true;
}

export function readInlineClipboard(
  clipboard: Pick<DataTransfer, "getData">,
  graphId: string,
): InlineContent[] | null {
  try {
    const value = JSON.parse(clipboard.getData(INLINE_CLIPBOARD_TYPE)) as {
      graph_id?: string;
      content?: InlineContent[];
    };
    return value.graph_id === graphId && Array.isArray(value.content) ? value.content : null;
  } catch {
    return null;
  }
}
