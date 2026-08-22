// The visual body of a block, independent of the surface that owns it.
//
// An outline row and a query result do not have the same behaviour: one is a
// structural editor and the other is a reference into that editor. They do,
// however, show the same block. These two small primitives keep that shared
// grammar in one DOM shape without pulling selection, dragging, query state, or
// navigation into a universal component full of modes.

import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

export function BlockRowFrame({
  prefix,
  gutter,
  gutterClassName,
  className,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "children" | "prefix"> & {
  prefix?: ReactNode;
  gutter: ReactNode;
  gutterClassName?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("block-row", className)} {...props}>
      {prefix}
      <span className={cn("block-gutter", gutterClassName)}>{gutter}</span>
      {children}
    </div>
  );
}

export function BlockBody({
  taskStatus,
  markCount = 0,
  className,
  children,
  ...props
}: Omit<HTMLAttributes<HTMLDivElement>, "children"> & {
  taskStatus?: string;
  markCount?: number;
  children?: ReactNode;
}) {
  return (
    <div
      className={cn("block-body", className)}
      data-task-status={taskStatus}
      data-marks={markCount > 0 ? markCount : undefined}
      {...props}
    >
      {children}
    </div>
  );
}
