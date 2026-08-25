// Shared token completion grammar for block Markdown editors.
//
// Detection and menu presentation are surface-independent. A surface adapter
// decides how the selected tag or slash action mutates the canonical block.

import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, HashIcon } from "lucide-react";
import type { TagSnapshot } from "../../../core-port/snapshot";
import { useI18n } from "../../../i18n";
import { useAnchoredPosition } from "@/ui/anchored";
import { useOverlayRoot } from "@/ui/overlay-root";
import { fuzzyScore } from "../../commands/registry";
import {
  SLASH_GROUP_ORDER,
  type SlashItem,
} from "./slash-commands";

const MENU_PLACEMENT = { width: 320, minWidth: 260, maxHeight: 320 } as const;

export interface BlockCompletionRequest {
  blockId: string;
  start: number;
  end: number;
  query: string;
  anchor: HTMLTextAreaElement;
}

export type BlockCompletion =
  | { kind: "slash"; request: BlockCompletionRequest; active: number }
  | { kind: "hash"; request: BlockCompletionRequest; active: number };

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
  return { start, end: selectionStart, query: token.slice(1) };
}

export function detectSlash(
  value: string,
  selectionStart: number,
  selectionEnd: number,
) {
  return detectToken("/", value, selectionStart, selectionEnd);
}

export function detectHash(
  value: string,
  selectionStart: number,
  selectionEnd: number,
) {
  return detectToken("#", value, selectionStart, selectionEnd);
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
  let matched: TagSnapshot[];
  if (!needle) {
    matched = [...tags].sort((left, right) => compare(left.name, right.name));
  } else {
    matched = tags
      .map((tag) => ({ tag, score: fuzzyScore(tag.name, needle) }))
      .filter((entry): entry is { tag: TagSnapshot; score: number } => entry.score !== null)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.tag);
  }
  return matched.slice(0, 8).map((tag) => ({
    id: tag.id,
    name: tag.name,
    present: present.has(tag.id),
  }));
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

export function BlockTagMenu({
  request,
  results,
  active,
  onHover,
  onChoose,
}: {
  request: BlockCompletionRequest;
  results: BlockTagOption[];
  active: number;
  onHover: (index: number) => void;
  onChoose: (option: BlockTagOption) => void;
}) {
  const { message } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const position = useAnchoredPosition(
    liveCompletionAnchor(request),
    MENU_PLACEMENT,
    results.length,
  );
  const overlayRoot = useOverlayRoot();

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-completion-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  return createPortal(
    <div
      id="tag-suggest-menu"
      ref={listRef}
      className="slash-menu tag-menu"
      style={position}
      role="listbox"
      aria-label={message("tags.menuLabel")}
      data-testid="tag-menu"
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
          <span className="slash-item-text"><strong>{option.name}</strong></span>
          {option.present && <CheckIcon className="tag-opt-check" aria-hidden />}
        </button>
      ))}
    </div>,
    overlayRoot,
  );
}

export function BlockSlashMenu({
  request,
  results,
  active,
  onHover,
  onChoose,
}: {
  request: BlockCompletionRequest;
  results: SlashItem[];
  active: number;
  onHover: (index: number) => void;
  onChoose: (item: SlashItem) => void;
}) {
  const { message } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  const position = useAnchoredPosition(
    liveCompletionAnchor(request),
    MENU_PLACEMENT,
    results.length,
  );
  const overlayRoot = useOverlayRoot();

  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-completion-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  const grouped = request.query.trim().length === 0;
  const sections = grouped
    ? SLASH_GROUP_ORDER
        .map((group) => ({ group, items: results.filter((item) => item.group === group) }))
        .filter((section) => section.items.length > 0)
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

  return createPortal(
    <div
      id="slash-command-menu"
      ref={listRef}
      className="slash-menu"
      style={position}
      role="listbox"
      aria-label={message("slash.menuLabel")}
      data-testid="slash-menu"
    >
      {sections.map((section) => (
        <div key={section.group ?? "ranked"} className="slash-group" role="presentation">
          {section.group && (
            <div className="group-label" role="presentation">
              {message(`slash.group.${section.group}` as
                | "slash.group.status"
                | "slash.group.priority"
                | "slash.group.date"
                | "slash.group.query"
                | "slash.group.property")}
            </div>
          )}
          {section.items.map(renderItem)}
        </div>
      ))}
    </div>,
    overlayRoot,
  );
}
