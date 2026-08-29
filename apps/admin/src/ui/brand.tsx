// The product mark.
//
// An `N` drawn in the outline's own language: one polyline, round joins, the
// same stroke weight as every icon in the interface, so it sits beside lucide
// glyphs without looking like a foreign object. One colour — there is no logo
// palette to keep in sync with two colour modes.

export function LogoMark({ className }: { className?: string }) {
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
