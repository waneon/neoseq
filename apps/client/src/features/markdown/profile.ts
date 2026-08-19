import { defaultSchema, type Options as SanitizeSchema } from "rehype-sanitize";
import type { UrlTransform } from "react-markdown";

/**
 * The product's Markdown dialect starts with CommonMark. This detector is only
 * a rendering fast path: plain text can stay in the textarea because its read
 * projection is visually identical. The parser remains the syntax authority.
 */
export function hasMarkdownSyntax(markdown: string): boolean {
  return markdown.includes("\n")
    || /(?:^|\s)(?:#{1,6}\s|>\s|[-+*]\s|\d+[.)]\s)/u.test(markdown)
    || /(?:^|\n) {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/u.test(markdown)
    || /^(?: {4}|\t)\S/u.test(markdown)
    || /(?:\\|`|\*|_|\[[^\]]*\](?:\(|\[)|!\[[^\]]*\]\()/u.test(markdown)
    || /<(?:https?:\/\/|mailto:)[^>]+>/iu.test(markdown)
    || /&(?:#[0-9]+|#x[0-9a-f]+|[a-z][a-z0-9]+);/iu.test(markdown)
    || /(?:^|[^\\])(?:\*[^*\n]+\*|_[^_\n]+_)/u.test(markdown);
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
    return parsed.protocol === "http:"
        || parsed.protocol === "https:"
        || parsed.protocol === "mailto:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};
