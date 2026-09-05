export const OUTLINE_FRAGMENT_KIND = "neoseq.outline" as const;
export const OUTLINE_FRAGMENT_VERSION = 2 as const;

export type {
  OutlineFragment,
  OutlineFragmentItem,
  OutlineFragmentTag,
  OutlineFragmentPage,
} from "../generated/domain";
