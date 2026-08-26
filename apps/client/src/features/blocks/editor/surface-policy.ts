import type { MarkdownVariant } from "../../markdown/BlockMarkdown";

export interface BlockSurfacePolicy {
  markdown: MarkdownVariant;
  enter: "split" | "commit";
  structure: boolean;
  visualLine: boolean;
  crossBlockWords: boolean;
}

/** Intentional differences between the three places canonical block text appears. */
export const BLOCK_SURFACE_POLICY = {
  outline: {
    markdown: "block",
    enter: "split",
    structure: true,
    visualLine: true,
    crossBlockWords: true,
  },
  queryList: {
    markdown: "block",
    enter: "commit",
    structure: false,
    visualLine: false,
    crossBlockWords: false,
  },
  queryTable: {
    markdown: "compact",
    enter: "commit",
    structure: false,
    visualLine: false,
    crossBlockWords: false,
  },
} as const satisfies Record<"outline" | "queryList" | "queryTable", BlockSurfacePolicy>;
