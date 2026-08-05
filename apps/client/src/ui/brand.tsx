// The product mark.
//
// An `N` drawn in the outline's own language: one polyline, round joins, the same
// 2px stroke weight as every icon in the interface, so it sits beside lucide
// glyphs without looking like a foreign object. It is a single colour — there is
// no logo palette to keep in sync with two colour modes, and nothing in this
// product is allowed a second chroma.

function LogoMark({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6 19V6l12 13V6" />
    </svg>
  );
}

/**
 * Mark plus name. `app.title` rather than a literal, because the tab title, the
 * picker and the rail must never be able to disagree about what the product is
 * called.
 */
export function Wordmark({ name, className }: { name: string; className?: string }) {
  return (
    <>
      <LogoMark className={className} />
      <span className="wordmark-name">{name}</span>
    </>
  );
}
