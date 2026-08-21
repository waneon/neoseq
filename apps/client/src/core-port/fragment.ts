import type { PropertyField } from "./snapshot";

export const OUTLINE_FRAGMENT_KIND = "neoseq.outline" as const;
export const OUTLINE_FRAGMENT_VERSION = 1 as const;

export interface OutlineFragment {
  kind: typeof OUTLINE_FRAGMENT_KIND;
  version: typeof OUTLINE_FRAGMENT_VERSION;
  source_graph_id: string;
  items: OutlineFragmentItem[];
  tags: OutlineFragmentTag[];
  pages: OutlineFragmentPage[];
}

export interface OutlineFragmentItem {
  depth: number;
  markdown: string;
  properties: PropertyField[];
  tags: string[];
}

export interface OutlineFragmentTag {
  id: string;
  name: string;
}

export interface OutlineFragmentPage {
  id: string;
  title: string;
  journal_date: string | null;
}
