import type { GraphSnapshot, PageDirectoryEntry } from "../core-port/snapshot";
import { pageTitle, journalDate } from "../core-port/snapshot";
/** Name identity used by the core: case-insensitive with collapsed whitespace. */
export function canonicalEntityName(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLowerCase();
}

export function nextAvailableEntityName(base: string, names: Iterable<string>): string {
  const occupied = new Set(Array.from(names, canonicalEntityName));
  if (!occupied.has(canonicalEntityName(base))) return base;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base} ${suffix}`;
    if (!occupied.has(canonicalEntityName(candidate))) return candidate;
  }
}

/** One derived directory for both document kinds, including lightweight test/legacy snapshots. */
export function namedDocuments(snapshot: GraphSnapshot): PageDirectoryEntry[] {
  const entries = new Map((snapshot.page_directory ?? []).map((entry) => [entry.id, entry]));
  for (const page of snapshot.pages)
    entries.set(
      page.id,
      entries.get(page.id) ?? {
        id: page.id,
        title: pageTitle(page),
        journal_date: journalDate(page) ?? null,
        deleted: false,
      },
    );
  for (const tag of snapshot.tags)
    entries.set(
      tag.id,
      entries.get(tag.id) ?? {
        id: tag.id,
        title: tag.name,
        journal_date: null,
        deleted: false,
      },
    );
  return [...entries.values()];
}
