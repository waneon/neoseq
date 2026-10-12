// The top bar holds the current document's controls, so the document itself
// begins with its title. A document renders its controls through this slot;
// without a shell (feature tests, embedded views) they render in place.

import { createContext, useContext, type ReactNode } from "react";
import { createPortal } from "react-dom";

export const DocumentChromeSlot = createContext<HTMLElement | null>(null);

export function DocumentChrome({ children }: { children: ReactNode }) {
  const slot = useContext(DocumentChromeSlot);
  if (!slot) return <div className="document-chrome-inline">{children}</div>;
  return createPortal(children, slot);
}
