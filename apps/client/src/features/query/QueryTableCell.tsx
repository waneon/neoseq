import type { ReactNode } from "react";

/**
 * The one geometry boundary every table value inhabits.
 *
 * Semantic renderers may change ink, glyphs, and inline decoration. They do not
 * own a table cell's padding, row height, typography, or interaction wash; this
 * frame does. Keeping the action as a sibling also means its disclosure never
 * changes the value's width or DOM shape.
 */
export function QueryTableCellFrame({
  children,
  action,
}: {
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="query-cell-frame" data-has-action={action ? true : undefined}>
      {children}
      {action}
    </div>
  );
}
