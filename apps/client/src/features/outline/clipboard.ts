import type {
  OutlineFragment,
  OutlineFragmentItem,
} from "../../core-port/fragment";
import {
  OUTLINE_FRAGMENT_KIND,
  OUTLINE_FRAGMENT_VERSION,
} from "../../core-port/fragment";
import type {
  BlockSnapshot,
  GraphSnapshot,
  PropertyField,
  PropertyValue,
} from "../../core-port/snapshot";
import { journalDate } from "../../core-port/snapshot";
import type { OutlineRow } from "../../entities/outline";
import { propertyCopyPolicy } from "../../entities/properties";
import { coveredMask } from "./selection";

export const NEOSEQ_OUTLINE_MIME = "application/vnd.neoseq.outline+json";
export const NEOSEQ_OUTLINE_WEB_MIME = `web ${NEOSEQ_OUTLINE_MIME}`;

export interface OutlineClipboardBundle {
  fragment: OutlineFragment;
  json: string;
  html: string;
  plain: string;
}

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

/**
 * Builds the lossless, versioned representation from authoritative DTOs. The
 * tree is walked instead of the virtual rows so a collapsed subtree is not
 * silently truncated. Block identities and lifecycle properties are not copy
 * data: a paste creates new nodes with a new lifecycle.
 */
export function createOutlineFragment(
  snapshot: GraphSnapshot,
  outline: { blocks: BlockSnapshot[] },
  selected: ReadonlySet<string>,
): OutlineFragment | null {
  const items: OutlineFragmentItem[] = [];
  const tagIds = new Set<string>();
  const pageIds = new Set<string>();

  const append = (block: BlockSnapshot, depth: number) => {
    const properties = block.properties
      .filter(isPortableField)
      .map(cloneField);
    for (const field of properties) {
      for (const value of field.values) {
        if (value.type === "page") pageIds.add(value.value);
      }
    }
    for (const tagId of block.tags) tagIds.add(tagId);
    for (const reference of block.page_references ?? []) pageIds.add(reference.page_id);
    items.push({
      depth,
      markdown: block.markdown,
      page_references: (block.page_references ?? []).map((reference) => ({ ...reference })),
      properties,
      tags: [...block.tags],
    });
    for (const child of block.children) append(child, depth + 1);
  };

  const visit = (blocks: readonly BlockSnapshot[]) => {
    for (const block of blocks) {
      if (selected.has(block.id)) append(block, 0);
      else visit(block.children);
    }
  };
  visit(outline.blocks);
  if (items.length === 0) return null;

  const tags = [...tagIds]
    .map((id) => snapshot.tags.find((tag) => tag.id === id))
    .filter((tag): tag is NonNullable<typeof tag> => tag !== undefined)
    .map((tag) => ({ id: tag.id, name: tag.name }));
  const knownTagIds = new Set(tags.map((tag) => tag.id));
  for (const item of items) item.tags = item.tags.filter((id) => knownTagIds.has(id));

  const directory = new Map((snapshot.page_directory ?? []).map((page) => [page.id, page]));
  const pages = [...pageIds].flatMap((id) => {
    const candidate = snapshot.pages.find((page) => page.id === id);
    const entry = directory.get(id);
    const title = candidate?.title ?? entry?.title;
    if (title === undefined) return [];
    return [{
      id,
      title,
      journal_date: candidate ? journalDate(candidate) ?? null : entry?.journal_date ?? null,
    }];
  });

  return {
    kind: OUTLINE_FRAGMENT_KIND,
    version: OUTLINE_FRAGMENT_VERSION,
    source_graph_id: snapshot.graph_id,
    items,
    tags,
    pages,
  };
}

export function isPlainEmptyBlock(block: BlockSnapshot, markdown = block.markdown): boolean {
  return markdown.length === 0
    && block.tags.length === 0
    && block.children.length === 0
    && block.properties.every((field) => propertyCopyPolicy(field.key) !== "portable");
}

export function buildClipboardBundle(fragment: OutlineFragment): OutlineClipboardBundle {
  return {
    fragment,
    json: JSON.stringify(fragment),
    html: serializeOutlineFragmentHtml(fragment),
    plain: serializeOutlineFragmentPlain(fragment),
  };
}

export function setClipboardData(
  clipboard: Pick<DataTransfer, "setData">,
  bundle: OutlineClipboardBundle,
): void {
  clipboard.setData(NEOSEQ_OUTLINE_MIME, bundle.json);
  clipboard.setData("text/html", bundle.html);
  clipboard.setData("text/plain", bundle.plain);
}

export async function writeClipboardBundle(bundle: OutlineClipboardBundle): Promise<void> {
  const write = navigator.clipboard?.write?.bind(navigator.clipboard);
  if (write && typeof ClipboardItem !== "undefined") {
    const standard = {
      "text/plain": new Blob([bundle.plain], { type: "text/plain" }),
      "text/html": new Blob([bundle.html], { type: "text/html" }),
    };
    try {
      await write([
        new ClipboardItem({
          ...standard,
          [NEOSEQ_OUTLINE_WEB_MIME]: new Blob([bundle.json], {
            type: NEOSEQ_OUTLINE_MIME,
          }),
        }),
      ]);
      return;
    } catch {
      // Some browsers expose ClipboardItem but not web custom formats. The
      // HTML representation still carries the fragment as a round-trip hint.
      await write([new ClipboardItem(standard)]);
      return;
    }
  }
  const writeText = navigator.clipboard?.writeText?.bind(navigator.clipboard);
  if (!writeText) throw new Error("Clipboard API unavailable");
  await writeText(bundle.plain);
}

export function readOutlineFragment(clipboard: Pick<DataTransfer, "getData">): OutlineFragment | null {
  for (const type of [NEOSEQ_OUTLINE_MIME, NEOSEQ_OUTLINE_WEB_MIME]) {
    const parsed = parseOutlineFragment(clipboard.getData(type));
    if (parsed) return parsed;
  }
  const html = clipboard.getData("text/html");
  if (!html || typeof DOMParser === "undefined") return null;
  const document = new DOMParser().parseFromString(html, "text/html");
  const encoded = document.querySelector<HTMLElement>("[data-neoseq-outline]")
    ?.dataset.neoseqOutline;
  return parseOutlineFragment(encoded ?? "");
}

export function serializeOutlineFragmentPlain(fragment: OutlineFragment): string {
  const tagNames = new Map(fragment.tags.map((tag) => [tag.id, tag.name]));
  const pageNames = new Map(fragment.pages.map((page) => [
    page.id,
    page.journal_date ?? page.title,
  ]));
  return fragment.items
    .flatMap((item) => {
      const indent = "  ".repeat(item.depth);
      const lines = item.markdown.replaceAll("\r\n", "\n").split("\n");
      const output = [lines[0] ? `${indent}- ${lines[0]}` : `${indent}-`];
      output.push(...lines.slice(1).map((line) => `${indent}  ${line}`));
      const tags = item.tags
        .map((id) => tagNames.get(id))
        .filter((name): name is string => name !== undefined)
        .map(formatTag);
      if (tags.length > 0) output.push(`${indent}  Tags: ${tags.join(" ")}`);
      for (const field of item.properties) {
        const value = field.values.length === 0
          ? ""
          : field.values.map((entry) => formatPropertyValue(entry, pageNames)).join(", ");
        const valueLines = value.split("\n");
        output.push(`${indent}  ${field.key}::${valueLines[0] ? ` ${valueLines[0]}` : ""}`);
        output.push(...valueLines.slice(1).map((line) => `${indent}    ${line}`));
      }
      return output;
    })
    .join("\n");
}

export function serializeOutlineFragmentHtml(fragment: OutlineFragment): string {
  const tagNames = new Map(fragment.tags.map((tag) => [tag.id, tag.name]));
  const pageNames = new Map(fragment.pages.map((page) => [
    page.id,
    page.journal_date ?? page.title,
  ]));
  const roots = outlineTree(fragment.items);
  const render = (nodes: readonly OutlineTreeNode[]): string => `<ul>${nodes.map((node) => {
    const content = escapeHtml(node.item.markdown).replaceAll("\n", "<br>");
    const tags = node.item.tags
      .map((id) => tagNames.get(id))
      .filter((name): name is string => name !== undefined)
      .map((name) => escapeHtml(formatTag(name)));
    const metadata = [
      tags.length > 0 ? `<div><strong>Tags:</strong> ${tags.join(" ")}</div>` : "",
      ...node.item.properties.map((field) => {
        const value = field.values.length === 0
          ? ""
          : field.values.map((entry) => formatPropertyValue(entry, pageNames)).join(", ");
        return `<div><strong>${escapeHtml(field.key)}:</strong>${value ? ` ${escapeHtml(value)}` : ""}</div>`;
      }),
    ].join("");
    return `<li><div>${content}</div>${metadata ? `<small>${metadata}</small>` : ""}${render(node.children)}</li>`;
  }).join("")}</ul>`;
  return `<div data-neoseq-outline="${escapeHtml(JSON.stringify(fragment))}">${render(roots)}</div>`;
}

function isPortableField(field: PropertyField): boolean {
  return propertyCopyPolicy(field.key) === "portable"
    && field.values.every((value) => value.type !== "unsupported_document");
}

function cloneField(field: PropertyField): PropertyField {
  return {
    ...field,
    values: field.values.map((value) => {
      if (value.type !== "document") return { ...value };
      return {
        ...value,
        value: {
          ...value.value,
          views: value.value.views.map((view) => ({
            ...view,
            definition: {
              ...view.definition,
              plan: view.definition.plan ? { ...view.definition.plan } : view.definition.plan,
            },
            columns: view.columns.map((column) => ({ ...column })),
            options: {
              ...view.options,
              sort: view.options.sort?.map((sort) => ({ ...sort })),
              list_sort: view.options.list_sort?.map((sort) => ({ ...sort })),
            },
          })),
        },
      };
    }),
  } as PropertyField;
}

function parseOutlineFragment(source: string): OutlineFragment | null {
  if (!source || source.length > 4 * 1_048_576) return null;
  try {
    const value: unknown = JSON.parse(source);
    if (!isRecord(value)
      || value.kind !== OUTLINE_FRAGMENT_KIND
      || (value.version !== 1 && value.version !== OUTLINE_FRAGMENT_VERSION)
      || typeof value.source_graph_id !== "string"
      || !Array.isArray(value.items)
      || !Array.isArray(value.tags)
      || !Array.isArray(value.pages)
      || value.items.length === 0
    ) return null;
    for (const item of value.items) {
      if (!isRecord(item)
        || !Number.isSafeInteger(item.depth)
        || (item.depth as number) < 0
        || typeof item.markdown !== "string"
        || (value.version === OUTLINE_FRAGMENT_VERSION && !Array.isArray(item.page_references))
        || !Array.isArray(item.properties)
        || !Array.isArray(item.tags)
      ) return null;
    }
    if (value.version === 1) {
      return {
        ...value,
        version: OUTLINE_FRAGMENT_VERSION,
        items: value.items.map((item) => ({
          ...(item as Record<string, unknown>),
          page_references: [],
        })),
      } as unknown as OutlineFragment;
    }
    return value as unknown as OutlineFragment;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatTag(name: string): string {
  return /\s/.test(name) ? `#[[${name}]]` : `#${name}`;
}

function formatPropertyValue(value: PropertyValue, pages: ReadonlyMap<string, string>): string {
  switch (value.type) {
    case "page": return `[[${pages.get(value.value) ?? value.value}]]`;
    case "checkbox": return value.value ? "true" : "false";
    case "document": {
      const view = value.value.views.find((item) => item.id === value.value.default_view_id)
        ?? value.value.views[0];
      return view?.definition.source ?? "";
    }
    case "unsupported_document": return `[${value.value.schema} v${value.value.version}]`;
    default: return String(value.value);
  }
}

interface OutlineTreeNode {
  item: OutlineFragmentItem;
  children: OutlineTreeNode[];
}

function outlineTree(items: readonly OutlineFragmentItem[]): OutlineTreeNode[] {
  const roots: OutlineTreeNode[] = [];
  const levels: OutlineTreeNode[] = [];
  for (const item of items) {
    const node = { item, children: [] } satisfies OutlineTreeNode;
    if (item.depth === 0) roots.push(node);
    else levels[item.depth - 1]?.children.push(node);
    levels[item.depth] = node;
    levels.length = item.depth + 1;
  }
  return roots;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
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
