import { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import type { UrlTransform } from "react-markdown";

/** Block constructs, each anchored to the start of a line with CommonMark's
    three-space indent tolerance. A `#` or `-` in the middle of a sentence is
    prose, not structure, and must not move a block out of its editor. */
const BLOCK_SYNTAX = [
  /^ {0,3}#{1,6}(?:\s|$)/m, //            ATX heading
  /^ {0,3}>/m, //                         block quote
  /^ {0,3}[-+*](?:\s|$)/m, //             bullet list item
  /^ {0,3}\d{1,9}[.)](?:\s|$)/m, //       ordered list item
  /^ {0,3}(?:```|~~~)/m, //               fenced code
  /^ {0,3}(?:\*[ \t]*){3,}$|^ {0,3}(?:-[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$/m, // thematic break
  /^(?: {4}|\t)\S/m, //                   indented code
  /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/m, // GFM table delimiter row
];

/** Inline constructs. Delimiters must be paired, because an unpaired one is
    literal text that renders as itself. Underscore emphasis additionally needs
    a non-word boundary, so `builtin_task_status` stays prose. */
const INLINE_SYNTAX = [
  /`[^`\n]+`/, //                                     code span
  /\*(?=\S)[^*\n]*\S\*/, //                           `*em*` and `**strong**`
  /(?:^|[^\w\\])_(?=\S)[^_\n]*\S_(?![\w])/, //        `_em_` and `__strong__`
  /~~(?=\S)[^~\n]*\S~~/, //                           GFM strikethrough
  /!?\[[^\]\n]*\](?:\(|\[)/, //                       links, images, reference links
  /<(?:https?:\/\/|mailto:)[^>\s]+>/i, //             autolink
  /(?:^|[\s(])(?:https?:\/\/|www\.)[^\s<>]+/i, //     GFM autolink literal
  /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]+);/i, //        character reference
  /\\[!-/:-@[-`{-~]/, //                              backslash escape
  /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/i, //         raw HTML, which the profile drops
];

/**
 * Decides whether a block needs its reading projection at all, and it answers
 * exactly one question: would parsing change what the reader sees? When the
 * answer is no, the block stays on the textarea fast path — no mode switch, no
 * caret to map back, no measurement of a second layout.
 *
 * A bare newline is deliberately not syntax here. Blocks are lines the author
 * broke on purpose, so the profile renders a soft break as a line break, which
 * is what the textarea already shows.
 */
export function hasMarkdownSyntax(markdown: string, semanticInline = false): boolean {
  return (
    semanticInline ||
    BLOCK_SYNTAX.some((pattern) => pattern.test(markdown)) ||
    INLINE_SYNTAX.some((pattern) => pattern.test(markdown))
  );
}

/**
 * Generated Markdown elements are sanitized even though raw HTML is never
 * interpreted. Keeping the allowlist at the profile boundary means future
 * plugins cannot silently widen what reaches React.
 */
export const markdownSanitizeSchema: SanitizeSchema = {
  ...defaultSchema,
  protocols: {
    ...defaultSchema.protocols,
    href: ["http", "https", "mailto"],
    // Images are rendered as inert alt text, never as a network-backed <img>.
    src: [],
  },
};

/** Only user-activated web and mail destinations leave a rendered block. */
export const markdownUrlTransform: UrlTransform = (url, key) => {
  if (key !== "href") return undefined;
  if (url.startsWith("#")) return url;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "mailto:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};
