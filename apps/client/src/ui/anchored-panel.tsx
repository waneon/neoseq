// A panel that belongs to a control.
//
// Query ordering and column visibility are richer than menus: their rows hold
// controls of their own. Radix Popover owns the common interaction contract —
// collision-aware placement, focus movement and looping, outside dismissal,
// Escape, and restoration — while callers own only their rows.

import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { Anchor, AnchoredOptions } from "./anchored";
import { OverlayRoot, useOverlayRoot } from "./overlay-root";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverPortal,
} from "./shadcn/popover";

const VIEWPORT_INSET = 12;

interface Measurable {
  getBoundingClientRect(): DOMRect;
}

function measurableAnchor(anchor: Anchor): Measurable {
  if (anchor instanceof HTMLElement) return anchor;
  if (anchor) return { getBoundingClientRect: () => anchor };
  return {
    getBoundingClientRect: () => DOMRect.fromRect({
      x: window.innerWidth / 2,
      y: VIEWPORT_INSET,
    }),
  };
}

function panelStyle(options: AnchoredOptions): CSSProperties {
  const availableWidth = `calc(100vw - ${VIEWPORT_INSET * 2}px)`;
  return {
    pointerEvents: "auto",
    width: options.width,
    minWidth: options.matchAnchorWidth
      ? options.minWidth === undefined
        ? "var(--radix-popover-trigger-width)"
        : `max(${options.minWidth}px, var(--radix-popover-trigger-width))`
      : options.minWidth,
    maxWidth: options.maxWidth === undefined
      ? availableWidth
      : `min(${options.maxWidth}px, ${availableWidth})`,
    maxHeight: options.maxHeight === undefined
      ? "var(--radix-popover-content-available-height)"
      : `min(${options.maxHeight}px, var(--radix-popover-content-available-height))`,
  };
}

export function AnchoredPanel({
  anchor,
  label,
  className,
  options = {},
  revision: _revision,
  testId,
  onClose,
  children,
}: {
  /** The control the panel hangs off; Escape gives it focus back. */
  anchor: Anchor;
  label: string;
  className: string;
  options?: AnchoredOptions;
  /** Content changes are observed by Radix and cause placement to be recomputed. */
  revision?: unknown;
  testId?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const root = useOverlayRoot();
  const [surface, setSurface] = useState<HTMLDivElement | null>(null);
  const escaped = useRef(false);
  const virtualRef = useMemo(
    () => ({ current: measurableAnchor(anchor) }),
    [anchor],
  );
  const rect = virtualRef.current.getBoundingClientRect();
  const align = (rect.left + rect.right) / 2 > window.innerWidth / 2 ? "end" : "start";

  return (
    <Popover open onOpenChange={(open) => !open && onClose()}>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverPortal container={root}>
        <PopoverContent
          ref={setSurface}
          className={className}
          role="dialog"
          aria-label={label}
          align={align}
          side="bottom"
          sideOffset={options.gap ?? 4}
          collisionPadding={VIEWPORT_INSET}
          sticky="always"
          style={panelStyle(options)}
          data-testid={testId}
          onEscapeKeyDown={() => {
            escaped.current = true;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (escaped.current && anchor instanceof HTMLElement) {
              anchor.focus({ preventScroll: true });
            }
          }}
        >
          <OverlayRoot node={surface}>{children}</OverlayRoot>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}
