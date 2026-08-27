// Viewport geometry for a caret inside a native textarea.
//
// Browsers expose selections for a textarea but not a DOM Range for its text.
// A hidden mirror is therefore the smallest reliable measuring surface: it has
// the same content width and typography, and a marker at the requested UTF-16
// offset gives the caret's visual line and column.

const MIRROR_ATTRIBUTE = "data-textarea-caret-mirror";

const COPIED_PROPERTIES = [
  "direction",
  "font-family",
  "font-size",
  "font-stretch",
  "font-style",
  "font-variant",
  "font-weight",
  "letter-spacing",
  "line-height",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "tab-size",
  "text-align",
  "text-indent",
  "text-transform",
  "word-break",
  "word-spacing",
] as const;

function number(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mirrorFor(document: Document): HTMLDivElement {
  const present = document.querySelector<HTMLDivElement>(`[${MIRROR_ATTRIBUTE}]`);
  if (present) return present;
  const mirror = document.createElement("div");
  mirror.setAttribute(MIRROR_ATTRIBUTE, "");
  mirror.setAttribute("aria-hidden", "true");
  document.body.append(mirror);
  return mirror;
}

/** Returns the visual caret box in viewport coordinates. */
export function textareaCaretRect(
  textarea: HTMLTextAreaElement,
  requestedOffset: number,
): DOMRect | null {
  if (!textarea.isConnected) return null;
  const textareaBox = textarea.getBoundingClientRect();
  if (textareaBox.width <= 0 || textareaBox.height <= 0) return null;

  const document = textarea.ownerDocument;
  const view = document.defaultView;
  if (!view) return null;
  const computed = view.getComputedStyle(textarea);
  const mirror = mirrorFor(document);
  mirror.removeAttribute("style");
  Object.assign(mirror.style, {
    boxSizing: "border-box",
    contain: "layout style paint",
    height: "auto",
    left: "-100000px",
    overflow: "hidden",
    overflowWrap: "break-word",
    pointerEvents: "none",
    position: "fixed",
    top: "0",
    visibility: "hidden",
    whiteSpace: "pre-wrap",
  });
  for (const property of COPIED_PROPERTIES) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }

  const borderLeft = number(computed.borderLeftWidth);
  const borderRight = number(computed.borderRightWidth);
  const borderTop = number(computed.borderTopWidth);
  const borderBottom = number(computed.borderBottomWidth);
  // clientWidth excludes borders and scrollbars, which is exactly the wrapping
  // width the textarea gives its own text.
  mirror.style.width = `${textarea.clientWidth + borderLeft + borderRight}px`;
  mirror.style.borderStyle = "solid";
  mirror.style.borderWidth = `${borderTop}px ${borderRight}px ${borderBottom}px ${borderLeft}px`;

  const offset = Math.max(0, Math.min(requestedOffset, textarea.value.length));
  mirror.textContent = textarea.value.slice(0, offset);
  const marker = document.createElement("span");
  // A visible glyph gives even an empty line a measurable inline box. The
  // mirror itself is hidden, so this never enters the accessibility or paint tree.
  marker.textContent = textarea.value.slice(offset, offset + 1) || ".";
  mirror.append(marker);

  const scaleX = textarea.offsetWidth > 0 ? textareaBox.width / textarea.offsetWidth : 1;
  const scaleY = textarea.offsetHeight > 0 ? textareaBox.height / textarea.offsetHeight : 1;
  const lineHeight = number(computed.lineHeight)
    || marker.getBoundingClientRect().height
    || number(computed.fontSize)
    || 1;
  const x = textareaBox.left + (marker.offsetLeft - textarea.scrollLeft) * scaleX;
  const y = textareaBox.top + (marker.offsetTop - textarea.scrollTop) * scaleY;
  mirror.replaceChildren();

  return DOMRect.fromRect({
    x,
    y,
    width: Math.max(scaleX, 1),
    height: Math.max(lineHeight * scaleY, 1),
  });
}
