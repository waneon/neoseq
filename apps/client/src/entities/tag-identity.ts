// What a tag *is*, beyond its name: how it is filed, and how it looks.
//
// Three registry keys on the tag's own metadata bag, none of which is ever copied
// onto a block — a tag's defaults say what it does, and these say what it is.
//
// A **group** is a name a tag carries, not an entity of its own. That is the whole
// model: a group exists because a tag is in it, it disappears when its last member
// leaves, renaming it rewrites its members, and there is nothing to keep in sync.
// A first-class group would have needed an ID, a lifecycle, an ordering, and a
// rule for what happens to an empty one, to buy exactly nothing a string does not
// already do.
//
// A **colour** is one of the eight named hue steps the accent itself offers —
// never a colour. Lightness and chroma stay the mode's, so a tag the reader
// paints red is the same measured distance from the page as the accent is, in
// both modes, and no choice on offer can produce an illegible tag
// (designs/foundations.md § Semantic Color). An unknown value simply reads as no
// colour.
//
// An **icon** is one grapheme of the reader's own text. It is stored as text and
// rendered as text: no image, no sprite sheet, no picker vocabulary to maintain.
//
// An **order** is one number, and it is the whole ordering model: tags sort by
// it inside their group, and a group sorts by the lowest one its members carry.
// So a group's place in the list is its members' places, which is the only thing
// it could be when a group is a name rather than a record. The arithmetic is
// `entities/ordering`, shared with the favourites rail — a fractional position
// is not a fact about tags.

import type { TagSnapshot } from "../core-port/snapshot";
import { numberValue, stringValue } from "../core-port/snapshot";
import { moveWrites, nextOrder, place, runWrites, type Placed, type Placement } from "./ordering";

export const TAG_GROUP_KEY = "builtin.tag-group";
export const TAG_ORDER_KEY = "builtin.tag-order";
export const TAG_COLOR_KEY = "builtin.tag-color";
export const TAG_ICON_KEY = "builtin.tag-icon";

export type TagColor = "red" | "orange" | "green" | "teal" | "blue" | "iris" | "violet" | "rose";

/** The order they are offered in: around the circle, starting warm. */
export const TAG_COLORS: TagColor[] = [
  "red",
  "orange",
  "green",
  "teal",
  "blue",
  "iris",
  "violet",
  "rose",
];

export function isTagColor(value: unknown): value is TagColor {
  return TAG_COLORS.includes(value as TagColor);
}

/** The tag's own hue, or `null` when it has not chosen one and speaks the accent. */
export function tagColor(tag: TagSnapshot): TagColor | null {
  const value = stringValue(tag.properties, TAG_COLOR_KEY);
  return isTagColor(value) ? value : null;
}

/**
 * The group a tag is filed under, or `null` for the ungrouped. Whitespace-only is
 * not a group: a name nobody can read is not a place anybody can find.
 */
export function tagGroup(tag: TagSnapshot): string | null {
  const value = stringValue(tag.properties, TAG_GROUP_KEY)?.trim();
  return value ? value : null;
}

/**
 * The tag's mark. One grapheme, so a pasted sentence cannot become an icon and
 * push every row in the list out of its column.
 */
export function tagIcon(tag: TagSnapshot): string | null {
  const value = stringValue(tag.properties, TAG_ICON_KEY)?.trim();
  if (!value) return null;
  const first = firstGrapheme(value);
  return first && !/\p{C}/u.test(first) ? first : null;
}

/** The one place the icon field's input is narrowed, so paste and type agree. */
export function normalizeTagIcon(raw: string): string {
  const first = firstGrapheme(raw.trim());
  return first && !/\p{C}/u.test(first) ? first : "";
}

function firstGrapheme(value: string): string {
  if (!value) return "";
  // `Intl.Segmenter` is the only thing that gets a flag or a family emoji right;
  // a code-point split would hand back half of one.
  if (typeof Intl.Segmenter === "function") {
    const [segment] = new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(value);
    return segment?.segment ?? "";
  }
  return [...value][0] ?? "";
}

export function tagOrder(tag: TagSnapshot): number | null {
  const value = numberValue(tag.properties, TAG_ORDER_KEY);
  return value !== undefined && Number.isFinite(value) ? value : null;
}

function placed(tag: TagSnapshot): Placed {
  return { id: tag.id, order: tagOrder(tag) };
}

/**
 * Where a brand-new tag goes: after everything, so creating one never reshuffles
 * what is already filed. Seeding it here is also what keeps ordinary moves to a
 * single write — a run whose members all carry a position never has to be
 * respaced.
 */
export function nextTagOrder(tags: TagSnapshot[]): number {
  return nextOrder(tags.map(placed));
}

/**
 * The writes that put `ordered` in that order, given that only `movedId` has
 * changed place.
 */
export function orderWrites(ordered: TagSnapshot[], movedId: string): Placement[] {
  return moveWrites(ordered.map(placed), movedId);
}

/**
 * The writes that move one group's whole run between its new neighbours. A group
 * has no record of its own, so its place *is* its members' places, and moving it
 * is moving them — bounded by the group's size, and the reason a group is
 * dragged far less often than a tag.
 */
export function groupOrderWrites(groups: TagGroupView[], movedIndex: number): Placement[] {
  return runWrites(
    groups.map((group) => group.tags.map(placed)),
    movedIndex,
  );
}

export interface TagGroupView {
  /** `null` is the ungrouped section, which is always last and cannot be renamed. */
  name: string | null;
  tags: TagSnapshot[];
}

/**
 * The graph's tags as the manager reads them: the reader's own order where they
 * have given one, their names where they have not, and everything unfiled
 * gathered at the end rather than scattered under a made-up heading.
 *
 * A group sorts by the lowest position its members carry, which is what makes
 * one number enough for both orders — a group's place *is* its members' places.
 */
export function groupedTags(
  tags: TagSnapshot[],
  compare: (left: string, right: string) => number,
): TagGroupView[] {
  const byOrder = (left: TagSnapshot, right: TagSnapshot) =>
    place(tagOrder(left), tagOrder(right)) || compare(left.name, right.name);
  const groups = new Map<string, TagSnapshot[]>();
  const ungrouped: TagSnapshot[] = [];
  for (const tag of tags) {
    const group = tagGroup(tag);
    if (group === null) {
      ungrouped.push(tag);
      continue;
    }
    const members = groups.get(group);
    if (members) members.push(tag);
    else groups.set(group, [tag]);
  }
  const rank = (members: TagSnapshot[]) => {
    const values = members.map(tagOrder).filter((value): value is number => value !== null);
    return values.length > 0 ? Math.min(...values) : null;
  };
  const ordered: TagGroupView[] = [...groups.entries()]
    .map(([name, members]) => ({ name, tags: [...members].sort(byOrder) }))
    .sort(
      (left, right) =>
        place(rank(left.tags), rank(right.tags)) || compare(left.name ?? "", right.name ?? ""),
    );
  if (ungrouped.length > 0) ordered.push({ name: null, tags: [...ungrouped].sort(byOrder) });
  return ordered;
}

/** Every group name in use, in the order the manager shows them. */
export function tagGroupNames(
  tags: TagSnapshot[],
  compare: (left: string, right: string) => number,
): string[] {
  return groupedTags(tags, compare)
    .map((group) => group.name)
    .filter((name): name is string => name !== null);
}
