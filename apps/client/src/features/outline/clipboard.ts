import type { OutlineRow } from "../../entities/outline";
import { coveredMask } from "./selection";

export interface OutlineClipboardItem {
  depth: number;
  markdown: string;
}

/**
 * Serializes the blocks a structural selection actually covers as a portable
 * Markdown list. The shallowest selected row becomes depth zero, so copying a
 * nested branch does not carry invisible ancestors into another document.
 */
export function serializeOutlineSelection(
  rows: readonly OutlineRow[],
  selected: ReadonlySet<string>,
): string {
  const mask = coveredMask(rows, selected);
  const covered = rows.filter((_row, index) => mask[index]);
  if (covered.length === 0) return "";
  const baseDepth = Math.min(...covered.map((row) => row.depth));

  return covered
    .flatMap((row) => {
      const indent = "  ".repeat(Math.max(0, row.depth - baseDepth));
      const lines = row.block.markdown.replaceAll("\r\n", "\n").split("\n");
      const first = lines[0] ? `${indent}- ${lines[0]}` : `${indent}-`;
      return [first, ...lines.slice(1).map((line) => `${indent}  ${line}`)];
    })
    .join("\n");
}

interface ParsedMarker {
  indent: number;
  contentIndent: number;
  markdown: string;
}

/**
 * Parses an unordered or ordered Markdown list into the normalized pre-order
 * shape the core accepts. Plain multiline text returns null and keeps the
 * browser's normal in-field paste behavior.
 */
export function parseMarkdownOutline(source: string): OutlineClipboardItem[] | null {
  const lines = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();
  if (lines.length === 0) return null;

  const result: OutlineClipboardItem[] = [];
  const levels: number[] = [];
  let current: (OutlineClipboardItem & { contentIndent: number }) | null = null;

  for (const line of lines) {
    const marker = parseMarker(line);
    if (marker) {
      let depth: number;
      if (levels.length === 0) {
        levels.push(marker.indent);
        depth = 0;
      } else {
        while (levels.length > 1 && marker.indent < levels.at(-1)!) levels.pop();
        if (marker.indent < levels[0]) levels[0] = marker.indent;
        if (marker.indent > levels.at(-1)!) levels.push(marker.indent);
        const exactDepth = levels.findIndex((indent) => indent === marker.indent);
        depth = exactDepth >= 0 ? exactDepth : levels.length - 1;
        const previousDepth = result.at(-1)?.depth ?? 0;
        depth = Math.min(depth, previousDepth + 1);
      }
      current = { depth, markdown: marker.markdown, contentIndent: marker.contentIndent };
      result.push(current);
      continue;
    }

    if (!current) return null;
    if (line.trim() === "") {
      current.markdown += "\n";
      continue;
    }
    const indentation = leadingColumns(line);
    if (indentation < current.contentIndent) return null;
    current.markdown += `\n${sliceColumns(line, current.contentIndent)}`;
  }

  return result.map(({ depth, markdown }) => ({ depth, markdown }));
}

function parseMarker(line: string): ParsedMarker | null {
  const match = /^([ \t]*)([-+*]|\d+[.)])(?:[ \t]+(.*)|[ \t]*)$/.exec(line);
  if (!match) return null;
  const indent = leadingColumns(match[1]);
  const markerEnd = match[1].length + match[2].length;
  let contentStart = markerEnd;
  while (line[contentStart] === " " || line[contentStart] === "\t") contentStart += 1;
  return {
    indent,
    contentIndent:
      indent + match[2].length + leadingColumns(line.slice(markerEnd, contentStart)),
    markdown: match[3] ?? "",
  };
}

function leadingColumns(value: string): number {
  let columns = 0;
  for (const character of value) {
    if (character === " ") columns += 1;
    else if (character === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

function sliceColumns(value: string, requested: number): string {
  let columns = 0;
  let index = 0;
  while (index < value.length && columns < requested) {
    if (value[index] === " ") columns += 1;
    else if (value[index] === "\t") columns += 4 - (columns % 4);
    else break;
    index += 1;
  }
  return value.slice(index);
}
