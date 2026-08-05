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
