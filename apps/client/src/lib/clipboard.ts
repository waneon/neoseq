// Programmatic copy that works wherever the client is served. The asynchronous
// Clipboard API exists only in secure contexts; a deployment reached over plain
// HTTP on a local network has no `navigator.clipboard` at all. The legacy route
// still works there: `document.execCommand("copy")` fires a `copy` event on the
// document, and a listener may fill its DataTransfer with as many
// representations as it likes. Keyboard copies never come here — the outline
// fills the browser's own `copy` event directly.

export type ClipboardRepresentations = Readonly<Record<string, string>> & {
  readonly "text/plain": string;
};

/** Writes every representation, preferring the asynchronous API. Resolves once
 * some clipboard holds at least the plain text; rejects when no route worked. */
export async function writeClipboard(representations: ClipboardRepresentations): Promise<void> {
  const clipboard = navigator.clipboard;
  if (clipboard) {
    if (typeof clipboard.write === "function" && typeof ClipboardItem !== "undefined") {
      const items = Object.fromEntries(
        Object.entries(representations).map(([type, value]) => [
          type,
          new Blob([value], { type: type.replace(/^web /, "") }),
        ]),
      );
      try {
        await clipboard.write([new ClipboardItem(items)]);
        return;
      } catch {
        // Some browsers expose ClipboardItem but reject custom formats. The
        // standard pair below is enough for every consumer outside Neoseq.
        const standard = Object.fromEntries(
          Object.entries(items).filter(([type]) => type === "text/plain" || type === "text/html"),
        );
        await clipboard.write([new ClipboardItem(standard)]);
        return;
      }
    }
    if (typeof clipboard.writeText === "function") {
      await clipboard.writeText(representations["text/plain"]);
      return;
    }
  }
  if (!copyThroughDocument(representations)) throw new Error("clipboard unavailable");
}

/** Plain-text convenience over {@link writeClipboard}. */
export function writeClipboardText(text: string): Promise<void> {
  return writeClipboard({ "text/plain": text });
}

function copyThroughDocument(representations: ClipboardRepresentations): boolean {
  if (typeof document === "undefined" || typeof document.execCommand !== "function") return false;
  let filled = false;
  const fill = (event: ClipboardEvent) => {
    const transfer = event.clipboardData;
    if (!transfer) return;
    for (const [type, value] of Object.entries(representations)) {
      transfer.setData(type.replace(/^web /, ""), value);
    }
    event.preventDefault();
    filled = true;
  };
  document.addEventListener("copy", fill, { capture: true });
  try {
    document.execCommand("copy");
  } finally {
    document.removeEventListener("copy", fill, { capture: true });
  }
  return filled;
}
