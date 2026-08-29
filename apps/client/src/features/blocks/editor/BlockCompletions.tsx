// Shared token completion grammar for block Markdown editors.
//
// Detection and menu presentation are surface-independent. A surface adapter
// decides how the selected tag or slash action mutates the canonical block.

import { useEffect, useRef } from "react";
import { CheckIcon, FileTextIcon, HashIcon, PlusIcon } from "lucide-react";
import type { PageDirectoryEntry, TagSnapshot } from "../../../core-port/snapshot";
import { useI18n } from "../../../i18n";
import { caretAnchor, type Anchor } from "@/ui/anchored";
import { AnchoredPanel } from "@/ui/anchored-panel";
import { fuzzyScore } from "../../commands/registry";
import { canonicalEntityName } from "../../../entities/names";
import { SLASH_GROUP_ORDER, type SlashItem } from "./slash-commands";

const MENU_PLACEMENT = { width: 320, minWidth: 260, maxHeight: 320 } as const;

export interface BlockCompletionRequest {
  blockId: string;
  start: number;
  end: number;
  query: string;
  /** Visual token origin; independent of the range accepting a choice replaces. */
  anchorOffset: number;
  anchor: HTMLTextAreaElement;
}

export type BlockCompletion =
  | { kind: "slash"; request: BlockCompletionRequest; active: number }
  | { kind: "hash"; request: BlockCompletionRequest; active: number }
  | { kind: "page"; request: BlockCompletionRequest; active: number };

export type BlockCompletionState = BlockCompletion | { kind: "none" };

export const NO_BLOCK_COMPLETION: BlockCompletionState = { kind: "none" };

export type BlockCompletionAction =
  | { type: "set"; completion: BlockCompletion | null }
  | { type: "activate"; kind: BlockCompletion["kind"]; index: number }
  | { type: "replace-block"; from: string; to: string };

export function blockCompletionReducer(
  state: BlockCompletionState,
  action: BlockCompletionAction,
): BlockCompletionState {
  switch (action.type) {
    case "set":
      return action.completion ?? NO_BLOCK_COMPLETION;
    case "activate":
      return state.kind === action.kind ? { ...state, active: action.index } : state;
    case "replace-block":
      if (state.kind === "none" || state.request.blockId !== action.from) return state;
      return { ...state, request: { ...state.request, blockId: action.to } };
  }
}

export interface BlockTagOption {
  id: string;
  name: string;
  present: boolean;
}

export interface BlockPageOption {
  id: string;
  title: string;
  create: boolean;
}

const COMPLETION_LIMIT = 8;

/** Keeps a tiny ordered frontier without allocating and sorting the directory. */
function insertBest<T>(best: T[], candidate: T, compare: (left: T, right: T) => number) {
  const at = best.findIndex((current) => compare(candidate, current) < 0);
  if (at < 0) {
    if (best.length < COMPLETION_LIMIT) best.push(candidate);
    return;
  }
  best.splice(at, 0, candidate);
  if (best.length > COMPLETION_LIMIT) best.pop();
}

function detectToken(
  marker: "/" | "#",
  value: string,
  selectionStart: number,
  selectionEnd: number,
): Omit<BlockCompletionRequest, "blockId" | "anchor"> | null {
  if (selectionStart !== selectionEnd) return null;
  let start = selectionStart;
  while (start > 0 && !/\s/u.test(value[start - 1])) start -= 1;
  const token = value.slice(start, selectionStart);
  if (!token.startsWith(marker) || token.slice(1).includes(marker)) return null;
  return { start, end: selectionStart, query: token.slice(1), anchorOffset: start };
}

export function detectSlash(value: string, selectionStart: number, selectionEnd: number) {
  return detectToken("/", value, selectionStart, selectionEnd);
}

export function detectHash(value: string, selectionStart: number, selectionEnd: number) {
  return detectToken("#", value, selectionStart, selectionEnd);
}

export function detectPage(
  value: string,
  selectionStart: number,
  selectionEnd: number,
): Omit<BlockCompletionRequest, "blockId" | "anchor"> | null {
  if (selectionStart !== selectionEnd) return null;
  const start = value.lastIndexOf("[[", selectionStart);
  if (start < 0 || value.slice(start + 2, selectionStart).includes("]]")) return null;
  if (start > 0 && value[start - 1] === "\\") return null;
  const close =
    value.slice(selectionStart, selectionStart + 2) === "]]" ? selectionStart + 2 : selectionStart;
  return {
    start,
    end: close,
    query: value.slice(start + 2, selectionStart),
    anchorOffset: start,
  };
}

/** Removes a completion token and the otherwise stranded trailing separator. */
export function removeCompletionToken(value: string, request: BlockCompletionRequest) {
  let head = value.slice(0, request.start);
  let tail = value.slice(request.end);
  if (tail.trim().length === 0) {
    head = head.replace(/\s+$/u, "");
    tail = "";
  }
  return { value: head + tail, caret: head.length };
}

/** Existing graph tags reached by a `#` token, best match first. */
export function filterTagOptions(
  tags: readonly TagSnapshot[],
  query: string,
  present: ReadonlySet<string>,
  compare: (left: string, right: string) => number,
): BlockTagOption[] {
  const needle = query.trim();
  const best: { tag: TagSnapshot; score: number }[] = [];
  for (const tag of tags) {
    const score = needle ? fuzzyScore(tag.name, needle) : 0;
    if (score === null) continue;
    insertBest(best, { tag, score }, (left, right) =>
      needle
        ? right.score - left.score || compare(left.tag.name, right.tag.name)
        : compare(left.tag.name, right.tag.name),
    );
  }
  return best.map(({ tag }) => ({
    id: tag.id,
    name: tag.name,
    present: present.has(tag.id),
  }));
}

export function filterPageOptions(
  pages: readonly PageDirectoryEntry[],
  query: string,
  compare: (left: string, right: string) => number,
): BlockPageOption[] {
  const needle = query.trim();
  const canonicalNeedle = canonicalEntityName(needle);
  const best: { page: PageDirectoryEntry; score: number }[] = [];
  let exact = false;
  for (const page of pages) {
    if (page.deleted) continue;
    const canonicalTitle = canonicalEntityName(page.title);
    if (canonicalTitle === canonicalNeedle) exact = true;
    const score = canonicalNeedle ? fuzzyScore(page.title, canonicalNeedle) : 0;
    if (score === null) continue;
    insertBest(best, { page, score }, (left, right) =>
      canonicalNeedle
        ? right.score - left.score || compare(left.page.title, right.page.title)
        : compare(left.page.title, right.page.title),
    );
  }
  const matches = best.map(({ page }) => ({
    id: page.id,
    title: page.title,
    create: false,
  }));
  if (canonicalNeedle && !exact) matches.push({ id: "", title: needle, create: true });
  return matches;
}

export function BlockPageMenu({
  request,
  results,
  active,
  onHover,
  onChoose,
  onClose,
}: {
  request: BlockCompletionRequest;
  results: BlockPageOption[];
  active: number;
  onHover: (index: number) => void;
  onChoose: (option: BlockPageOption) => void;
  onClose: () => void;
}) {
  const { message } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-completion-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  return (
    <AnchoredPanel
      anchor={completionAnchor(request)}
      id="page-reference-menu"
      className="slash-menu page-reference-menu"
      role="listbox"
      label={message("pageReferences.menuLabel")}
      options={MENU_PLACEMENT}
      revision={results.length}
      surfaceRef={listRef}
      preserveAnchorFocus
      onClose={onClose}
      testId="page-reference-menu"
    >
      {results.map((option, index) => (
        <button
          id={`page-reference-opt-${index}`}
          key={option.create ? `create:${option.title}` : option.id}
          role="option"
          aria-selected={index === active}
          data-active={index === active}
          data-completion-index={index}
          tabIndex={-1}
          onPointerMove={() => onHover(index)}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onChoose(option)}
        >
          {option.create ? <PlusIcon aria-hidden /> : <FileTextIcon aria-hidden />}
          <span className="slash-item-text">
            <strong>{option.title}</strong>
            {option.create && <small>{message("pageReferences.create")}</small>}
          </span>
        </button>
      ))}
    </AnchoredPanel>
  );
}

/** Resolves an optimistic editor request to the canonical textarea that replaced it. */
export function liveCompletionAnchor(request: BlockCompletionRequest): HTMLTextAreaElement {
  const focused = document.activeElement;
  return request.anchor.isConnected
    ? request.anchor
    : focused instanceof HTMLTextAreaElement && focused.hasAttribute("data-block-editor")
      ? focused
      : request.anchor;
}

/** One completion policy for slash, tag and page tokens: stable at their origin. */
export function completionAnchor(request: BlockCompletionRequest): Anchor {
  return caretAnchor(liveCompletionAnchor(request), request.anchorOffset);
}

export function BlockTagMenu({
  request,
  results,
  active,
  onHover,
  onChoose,
  onClose,
}: {
  request: BlockCompletionRequest;
  results: BlockTagOption[];
  active: number;
  onHover: (index: number) => void;
  onChoose: (option: BlockTagOption) => void;
  onClose: () => void;
}) {
  const { message } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-completion-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  return (
    <AnchoredPanel
      anchor={completionAnchor(request)}
      id="tag-suggest-menu"
      className="slash-menu tag-menu"
      role="listbox"
      label={message("tags.menuLabel")}
      options={MENU_PLACEMENT}
      revision={results.length}
      surfaceRef={listRef}
      preserveAnchorFocus
      onClose={onClose}
      testId="tag-menu"
    >
      {results.map((option, index) => (
        <button
          id={`tag-opt-${index}`}
          key={option.id}
          role="option"
          aria-selected={index === active}
          data-active={index === active}
          data-completion-index={index}
          tabIndex={-1}
          onPointerMove={() => onHover(index)}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => onChoose(option)}
        >
          <HashIcon aria-hidden />
          <span className="slash-item-text">
            <strong>{option.name}</strong>
          </span>
          {option.present && <CheckIcon className="tag-opt-check" aria-hidden />}
        </button>
      ))}
    </AnchoredPanel>
  );
}

export function BlockSlashMenu({
  request,
  results,
  active,
  onHover,
  onChoose,
  onClose,
}: {
  request: BlockCompletionRequest;
  results: SlashItem[];
  active: number;
  onHover: (index: number) => void;
  onChoose: (item: SlashItem) => void;
  onClose: () => void;
}) {
  const { message } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-completion-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  const grouped = request.query.trim().length === 0;
  const sections = grouped
    ? SLASH_GROUP_ORDER.map((group) => ({
        group,
        items: results.filter((item) => item.group === group),
      })).filter((section) => section.items.length > 0)
    : [{ group: null, items: results }];

  const renderItem = (item: SlashItem) => {
    const index = results.indexOf(item);
    return (
      <button
        id={`slash-opt-${item.id}`}
        key={item.id}
        role="option"
        aria-selected={index === active}
        data-active={index === active}
        data-completion-index={index}
        tabIndex={-1}
        onPointerMove={() => onHover(index)}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => onChoose(item)}
      >
        {item.glyph}
        <span className="slash-item-text">
          <strong>{item.label}</strong>
          {item.hint && <small>{item.hint}</small>}
        </span>
      </button>
    );
  };

  return (
    <AnchoredPanel
      anchor={completionAnchor(request)}
      id="slash-command-menu"
      className="slash-menu"
      role="listbox"
      label={message("slash.menuLabel")}
      options={MENU_PLACEMENT}
      revision={results.length}
      surfaceRef={listRef}
      preserveAnchorFocus
      onClose={onClose}
      testId="slash-menu"
    >
      {sections.map((section) => (
        <div key={section.group ?? "ranked"} className="slash-group" role="presentation">
          {section.group && (
            <div className="group-label" role="presentation">
              {message(
                `slash.group.${section.group}` as
                  | "slash.group.status"
                  | "slash.group.priority"
                  | "slash.group.date"
                  | "slash.group.query"
                  | "slash.group.property",
              )}
            </div>
          )}
          {section.items.map(renderItem)}
        </div>
      ))}
    </AnchoredPanel>
  );
}
