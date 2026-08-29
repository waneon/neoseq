import type { OutlineFragment, OutlineFragmentItem } from "../../core-port/fragment";
import { OUTLINE_FRAGMENT_KIND, OUTLINE_FRAGMENT_VERSION } from "../../core-port/fragment";
import type {
  BlockSnapshot,
  GraphSnapshot,
  PropertyField,
  PropertyValue,
} from "../../core-port/snapshot";
import { journalDate } from "../../core-port/snapshot";
import { propertyCopyPolicy } from "../../entities/properties";

export const NEOSEQ_OUTLINE_MIME = "application/vnd.neoseq.outline+json";
export const NEOSEQ_OUTLINE_WEB_MIME = `web ${NEOSEQ_OUTLINE_MIME}`;
const MAX_CLIPBOARD_SOURCE_LENGTH = 4 * 1_048_576;
const MAX_CLIPBOARD_ITEMS = 10_000;
const IGNORED_HTML_TAGS = new Set(["script", "style", "template", "noscript"]);
const BLOCK_HTML_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "footer",
  "header",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "main",
  "nav",
  "p",
  "pre",
  "section",
]);

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

export type DecodedOutlineClipboard =
  | { kind: "fragment"; fragment: OutlineFragment }
  | { kind: "outline"; items: OutlineClipboardItem[]; source: "html" | "markdown" }
  | { kind: "text" };

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
    const properties = block.properties.filter(isPortableField).map(cloneField);
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
    return [
      {
        id,
        title,
        journal_date: candidate ? (journalDate(candidate) ?? null) : (entry?.journal_date ?? null),
      },
    ];
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
  return (
    markdown.length === 0 &&
    block.tags.length === 0 &&
    block.children.length === 0 &&
    block.properties.every((field) => propertyCopyPolicy(field.key) !== "portable")
  );
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

export function readOutlineFragment(
  clipboard: Pick<DataTransfer, "getData">,
): OutlineFragment | null {
  for (const type of [NEOSEQ_OUTLINE_MIME, NEOSEQ_OUTLINE_WEB_MIME]) {
    const parsed = parseOutlineFragment(clipboard.getData(type));
    if (parsed) return parsed;
  }
  const html = clipboard.getData("text/html");
  if (!html || typeof DOMParser === "undefined") return null;
  const document = new DOMParser().parseFromString(html, "text/html");
  const encoded =
    document.querySelector<HTMLElement>("[data-neoseq-outline]")?.dataset.neoseqOutline;
  return parseOutlineFragment(encoded ?? "");
}

/** Resolves every clipboard representation at one format-policy boundary. */
export function decodeOutlineClipboard(
  clipboard: Pick<DataTransfer, "getData">,
): DecodedOutlineClipboard {
  const fragment = readOutlineFragment(clipboard);
  if (fragment) return { kind: "fragment", fragment };

  const html = parseHtmlOutline(clipboard.getData("text/html"));
  if (html) return { kind: "outline", items: html, source: "html" };

  const markdown = parseMarkdownOutline(clipboard.getData("text/plain"));
  if (markdown) return { kind: "outline", items: markdown, source: "markdown" };

  return { kind: "text" };
}

export function serializeOutlineFragmentPlain(fragment: OutlineFragment): string {
  const tagNames = new Map(fragment.tags.map((tag) => [tag.id, tag.name]));
  const pageNames = new Map(
    fragment.pages.map((page) => [page.id, page.journal_date ?? page.title]),
  );
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
        const value =
          field.values.length === 0
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
  const pageNames = new Map(
    fragment.pages.map((page) => [page.id, page.journal_date ?? page.title]),
  );
  const roots = outlineTree(fragment.items);
  const render = (nodes: readonly OutlineTreeNode[]): string => {
    if (nodes.length === 0) return "";
    const items = nodes
      .map((node) => {
        const content = escapeHtml(node.item.markdown).replaceAll("\n", "<br>");
        const tags = node.item.tags
          .map((id) => tagNames.get(id))
          .filter((name): name is string => name !== undefined)
          .map((name) => escapeHtml(formatTag(name)));
        const metadata = [
          tags.length > 0 ? `<div><strong>Tags:</strong> ${tags.join(" ")}</div>` : "",
          ...node.item.properties.map((field) => {
            const value =
              field.values.length === 0
                ? ""
                : field.values.map((entry) => formatPropertyValue(entry, pageNames)).join(", ");
            const label = `<strong>${escapeHtml(field.key)}:</strong>`;
            return `<div>${label}${value ? ` ${escapeHtml(value)}` : ""}</div>`;
          }),
        ].join("");
        const metadataHtml = metadata ? `<small data-neoseq-metadata>${metadata}</small>` : "";
        return `<li><div data-neoseq-block-content>${content}</div>${metadataHtml}${render(node.children)}</li>`;
      })
      .join("");
    return `<ul>${items}</ul>`;
  };
  return `<div data-neoseq-outline="${escapeHtml(JSON.stringify(fragment))}">${render(roots)}</div>`;
}

function isPortableField(field: PropertyField): boolean {
  return (
    propertyCopyPolicy(field.key) === "portable" &&
    field.values.every((value) => value.type !== "unsupported_document")
  );
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
    if (
      !isRecord(value) ||
      value.kind !== OUTLINE_FRAGMENT_KIND ||
      (value.version !== 1 && value.version !== OUTLINE_FRAGMENT_VERSION) ||
      typeof value.source_graph_id !== "string" ||
      !Array.isArray(value.items) ||
      !Array.isArray(value.tags) ||
      !Array.isArray(value.pages) ||
      value.items.length === 0
    )
      return null;
    for (const item of value.items) {
      if (
        !isRecord(item) ||
        !Number.isSafeInteger(item.depth) ||
        (item.depth as number) < 0 ||
        typeof item.markdown !== "string" ||
        (value.version === OUTLINE_FRAGMENT_VERSION && !Array.isArray(item.page_references)) ||
        !Array.isArray(item.properties) ||
        !Array.isArray(item.tags)
      )
        return null;
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
    case "page":
      return `[[${pages.get(value.value) ?? value.value}]]`;
    case "checkbox":
      return value.value ? "true" : "false";
    case "document": {
      const view =
        value.value.views.find((item) => item.id === value.value.default_view_id) ??
        value.value.views[0];
      return view?.definition.source ?? "";
    }
    case "unsupported_document":
      return `[${value.value.schema} v${value.value.version}]`;
    default:
      return String(value.value);
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
 * Reads an HTML document fragment containing a semantic list. Prose around the
 * list remains in source order as root blocks; ul/ol/li alone establishes tree
 * depth. Application wrappers and attributes are deliberately irrelevant.
 */
export function parseHtmlOutline(source: string): OutlineClipboardItem[] | null {
  if (!source || source.length > MAX_CLIPBOARD_SOURCE_LENGTH || typeof DOMParser === "undefined")
    return null;

  const document = new DOMParser().parseFromString(source, "text/html");
  if (!document.querySelector("ul li, ol li")) return null;

  const items: OutlineClipboardItem[] = [];
  if (!appendHtmlFlow(document.body, 0, items)) return null;
  return items.length > 0 ? items : null;
}

function appendHtmlFlow(parent: Element, depth: number, items: OutlineClipboardItem[]): boolean {
  const inline: Node[] = [];
  const flushInline = () => {
    const markdown = normalizeHtmlMarkdown(inline.map(renderHtmlContent).join(""));
    inline.length = 0;
    return appendHtmlMarkdown(items, depth, markdown);
  };

  for (const child of parent.childNodes) {
    if (child.nodeType !== 1) {
      inline.push(child);
      continue;
    }
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (tag === "ul" || tag === "ol") {
      if (!flushInline() || !appendHtmlList(element, depth, items)) return false;
      continue;
    }
    if (hasHtmlFlowChildren(element)) {
      if (!flushInline() || !appendHtmlFlow(element, depth, items)) return false;
      continue;
    }
    if (BLOCK_HTML_TAGS.has(tag)) {
      if (!flushInline()) return false;
      const markdown = normalizeHtmlMarkdown(renderHtmlContent(element));
      if (!appendHtmlMarkdown(items, depth, markdown)) return false;
      continue;
    }
    inline.push(child);
  }
  return flushInline();
}

function hasHtmlFlowChildren(element: Element): boolean {
  if (element.querySelector("ul, ol")) return true;
  return [...element.children].some((child) => {
    const tag = child.tagName.toLowerCase();
    return tag === "ul" || tag === "ol" || BLOCK_HTML_TAGS.has(tag);
  });
}

function appendHtmlMarkdown(
  items: OutlineClipboardItem[],
  depth: number,
  markdown: string,
): boolean {
  if (!markdown) return true;
  if (items.length >= MAX_CLIPBOARD_ITEMS) return false;
  items.push({ depth, markdown });
  return true;
}

function appendHtmlList(list: Element, depth: number, items: OutlineClipboardItem[]): boolean {
  const pending = ownedHtmlListItems(list)
    .map((item) => ({ item, depth }))
    .reverse();
  while (pending.length > 0) {
    if (items.length >= MAX_CLIPBOARD_ITEMS) return false;
    const current = pending.pop()!;
    items.push({
      depth: current.depth,
      markdown: htmlListItemMarkdown(current.item),
    });
    const children = ownedHtmlChildLists(current.item).flatMap((list) => ownedHtmlListItems(list));
    for (let index = children.length - 1; index >= 0; index -= 1) {
      pending.push({ item: children[index], depth: current.depth + 1 });
    }
  }
  return true;
}

function ownedHtmlListItems(list: Element): Element[] {
  const items: Element[] = [];
  const visit = (parent: Element) => {
    for (const child of parent.children) {
      const tag = child.tagName.toLowerCase();
      if (tag === "li") items.push(child);
      else if (tag !== "ul" && tag !== "ol") visit(child);
    }
  };
  visit(list);
  return items;
}

function ownedHtmlChildLists(item: Element): Element[] {
  const lists: Element[] = [];
  const visit = (parent: Element) => {
    for (const child of parent.children) {
      const tag = child.tagName.toLowerCase();
      if (tag === "ul" || tag === "ol") lists.push(child);
      else if (tag !== "li") visit(child);
    }
  };
  visit(item);
  return lists;
}

function htmlListItemMarkdown(item: Element): string {
  const explicit = [...item.querySelectorAll("[data-neoseq-block-content]")].find(
    (candidate) => candidate.closest("li") === item,
  );
  if (explicit) return normalizeHtmlMarkdown(renderHtmlContent(explicit));

  const content = item.cloneNode(true) as Element;
  for (const nested of content.querySelectorAll("ul, ol, [data-neoseq-metadata]")) {
    nested.remove();
  }
  return normalizeHtmlMarkdown(renderHtmlContent(content));
}

function renderHtmlContent(node: Node): string {
  if (node.nodeType === 3) return node.textContent ?? "";
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (IGNORED_HTML_TAGS.has(tag)) return "";
  if (tag === "br") return "\n";

  const content = [...element.childNodes].map(renderHtmlContent).join("");
  if (tag === "strong" || tag === "b") return content ? `**${content}**` : "";
  if (tag === "em" || tag === "i") return content ? `*${content}*` : "";
  if (tag === "code") return content ? `\`${content}\`` : "";
  if (BLOCK_HTML_TAGS.has(tag)) return `${content}\n`;
  return content;
}

function normalizeHtmlMarkdown(value: string): string {
  return value
    .replaceAll("\u00a0", " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Parses an unordered or ordered Markdown list into the normalized pre-order
 * shape the core accepts. Plain multiline text returns null and keeps the
 * browser's normal in-field paste behavior.
 */
export function parseMarkdownOutline(source: string): OutlineClipboardItem[] | null {
  if (!source || source.length > MAX_CLIPBOARD_SOURCE_LENGTH) return null;
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
      if (result.length >= MAX_CLIPBOARD_ITEMS) return null;
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
  const match = /^([ \t\u00a0]*)([-+*•◦▪‣⁃]|\d+[.)])(?:[ \t\u00a0]+(.*)|[ \t\u00a0]*)$/.exec(line);
  if (!match) return null;
  const indent = leadingColumns(match[1]);
  const markerEnd = match[1].length + match[2].length;
  let contentStart = markerEnd;
  while ([" ", "\t", "\u00a0"].includes(line[contentStart])) contentStart += 1;
  return {
    indent,
    contentIndent: indent + match[2].length + leadingColumns(line.slice(markerEnd, contentStart)),
    markdown: match[3] ?? "",
  };
}

function leadingColumns(value: string): number {
  let columns = 0;
  for (const character of value) {
    if (character === " " || character === "\u00a0") columns += 1;
    else if (character === "\t") columns += 4 - (columns % 4);
    else break;
  }
  return columns;
}

function sliceColumns(value: string, requested: number): string {
  let columns = 0;
  let index = 0;
  while (index < value.length && columns < requested) {
    if (value[index] === " " || value[index] === "\u00a0") columns += 1;
    else if (value[index] === "\t") columns += 4 - (columns % 4);
    else break;
    index += 1;
  }
  return value.slice(index);
}
