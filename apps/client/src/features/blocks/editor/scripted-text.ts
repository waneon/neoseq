/**
 * Replaces a range of a textarea's text from script. React keeps the last value
 * it saw to decide whether an input event changed anything, and `setRangeText`
 * bypasses that record: the next keystroke that restores the earlier text would
 * read as no change at all. Writing the value through the element's setter
 * brings the record up to date.
 */
export function replaceTextRange(
  textarea: HTMLTextAreaElement,
  insert: string,
  from: number,
  to: number,
  selectionMode: SelectionMode,
): void {
  textarea.setRangeText(insert, from, to, selectionMode);
  const { value, selectionStart, selectionEnd, selectionDirection } = textarea;
  textarea.value = value;
  textarea.setSelectionRange(selectionStart, selectionEnd, selectionDirection);
}
