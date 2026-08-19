import {
  memo,
  useRef,
  type FocusEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";
import Markdown, { type Components } from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/utils";
import { sourceOffsetFromPoint } from "./caret";
import { markdownSanitizeSchema, markdownUrlTransform } from "./profile";

export type MarkdownVariant = "block" | "compact";

export interface BlockMarkdownProps {
  markdown: string;
  variant?: MarkdownVariant;
  className?: string;
  /**
   * Activates the source editor when non-interactive rendered text is pressed,
   * with the source offset under the pointer, or `undefined` for the end of the
   * block when the projection was reached by keyboard.
   */
  onActivate?: (caret?: number) => void;
}

/** A soft break inside a block is a line the author broke: `remark-breaks`
    keeps it one, and GFM adds the tables, strikethrough, and bare links people
    actually write. Neither plugin can reach graph semantics. */
const remarkPlugins = [remarkGfm, remarkBreaks];

/** The outline's own threshold for "this press became a drag". */
const DRAG_THRESHOLD_PX = 4;

function InertImage({ alt }: { alt?: string }) {
  if (!alt) return null;
  return <span className="markdown-image-alt">{alt}</span>;
}

function SafeLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href) return <span className="markdown-link-blocked">{children}</span>;
  const external = /^https?:\/\//iu.test(href);
  return (
    <a
      href={href}
      target={external ? "_blank" : undefined}
      rel={external ? "noopener noreferrer" : undefined}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </a>
  );
}

const blockComponents: Components = {
  h1: ({ children }) => (
    <h2 className="markdown-heading" data-level="1">{children}</h2>
  ),
  h2: ({ children }) => (
    <h3 className="markdown-heading" data-level="2">{children}</h3>
  ),
  h3: ({ children }) => (
    <h4 className="markdown-heading" data-level="3">{children}</h4>
  ),
  h4: ({ children }) => (
    <h5 className="markdown-heading" data-level="4">{children}</h5>
  ),
  h5: ({ children }) => (
    <h6 className="markdown-heading" data-level="5">{children}</h6>
  ),
  h6: ({ children }) => (
    <h6 className="markdown-heading" data-level="6">{children}</h6>
  ),
  // A table is the one construct that can outgrow the measure, so it scrolls
  // inside the block instead of widening the outline.
  table: ({ children }) => (
    <div className="markdown-table-wrap">
      <table>{children}</table>
    </div>
  ),
  a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
  img: ({ alt }) => <InertImage alt={alt} />,
};

/**
 * Query cells are frequently buttons that open an editor. Their projection is
 * phrasing-only, so Markdown never creates nested interactive or block content
 * inside that button, and never a second line inside a one-line row.
 */
const compactComponents: Components = {
  p: ({ children }) => <span className="markdown-compact-paragraph">{children}</span>,
  h1: ({ children }) => <strong className="markdown-compact-heading">{children}</strong>,
  h2: ({ children }) => <strong className="markdown-compact-heading">{children}</strong>,
  h3: ({ children }) => <strong className="markdown-compact-heading">{children}</strong>,
  h4: ({ children }) => <strong className="markdown-compact-heading">{children}</strong>,
  h5: ({ children }) => <strong className="markdown-compact-heading">{children}</strong>,
  h6: ({ children }) => <strong className="markdown-compact-heading">{children}</strong>,
  blockquote: ({ children }) => (
    <span className="markdown-compact-quote">{children}</span>
  ),
  ul: ({ children }) => (
    <span className="markdown-compact-list" data-kind="unordered">{children}</span>
  ),
  ol: ({ children }) => (
    <span className="markdown-compact-list" data-kind="ordered">{children}</span>
  ),
  li: ({ children }) => <span className="markdown-compact-list-item">{children}</span>,
  pre: ({ children }) => <span className="markdown-compact-pre">{children}</span>,
  table: ({ children }) => <span className="markdown-compact-table">{children}</span>,
  thead: ({ children }) => <span className="markdown-compact-row-group">{children}</span>,
  tbody: ({ children }) => <span className="markdown-compact-row-group">{children}</span>,
  tr: ({ children }) => <span className="markdown-compact-row">{children}</span>,
  th: ({ children }) => <span className="markdown-compact-cell">{children}</span>,
  td: ({ children }) => <span className="markdown-compact-cell">{children}</span>,
  hr: () => <span className="markdown-compact-break" aria-hidden> · · · </span>,
  br: () => <span> </span>,
  input: ({ checked }) => (
    <span className="markdown-compact-task" data-checked={checked ?? false} />
  ),
  a: ({ children }) => <span className="markdown-compact-link">{children}</span>,
  img: ({ alt }) => <InertImage alt={alt} />,
};

function BlockMarkdownView({
  markdown,
  variant = "block",
  className,
  onActivate,
}: BlockMarkdownProps) {
  const compact = variant === "compact";
  const pressOrigin = useRef<{ x: number; y: number } | null>(null);

  const beginPress = (event: PointerEvent<HTMLElement>) => {
    pressOrigin.current = { x: event.clientX, y: event.clientY };
  };

  const activate = (event: MouseEvent<HTMLElement>) => {
    if (!onActivate || event.defaultPrevented || event.button !== 0) return;
    const target = event.target;
    if (target instanceof Element && target.closest("a, button, input")) return;
    // A press that travelled was a drag, and in this outline a drag over quiet
    // writing surface already means something: a text selection, or the block
    // range selection that crossing a row starts. Either way it is not a
    // request to open the editor, and opening one would undo it.
    const origin = pressOrigin.current;
    pressOrigin.current = null;
    if (
      origin
      && Math.abs(event.clientX - origin.x) + Math.abs(event.clientY - origin.y)
        >= DRAG_THRESHOLD_PX
    ) {
      return;
    }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) return;
    const caret = sourceOffsetFromPoint(
      event.currentTarget,
      event.clientX,
      event.clientY,
      markdown,
    );
    onActivate(caret ?? undefined);
  };

  // The projection stands in for the textarea, so it has to stand in for its
  // tab stop too — otherwise a page of rendered blocks has none. A pointer
  // press is left to `activate`, which knows where the caret belongs.
  const handOver = (event: FocusEvent<HTMLElement>) => {
    if (!onActivate || event.target !== event.currentTarget) return;
    if (!event.currentTarget.matches(":focus-visible")) return;
    onActivate();
  };

  const Root = compact ? "span" : "div";

  return (
    <Root
      className={cn("block-markdown", className)}
      data-variant={variant}
      data-testid="block-markdown"
      dir="auto"
      tabIndex={compact || !onActivate ? undefined : 0}
      onPointerDown={compact ? undefined : beginPress}
      onClick={activate}
      onFocus={compact ? undefined : handOver}
    >
      <Markdown
        components={compact ? compactComponents : blockComponents}
        remarkPlugins={remarkPlugins}
        rehypePlugins={[[rehypeSanitize, markdownSanitizeSchema]]}
        skipHtml
        urlTransform={markdownUrlTransform}
      >
        {markdown}
      </Markdown>
    </Root>
  );
}

export const BlockMarkdown = memo(BlockMarkdownView);
