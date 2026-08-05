// The ⌘/ sheet. Generated from the binding table so it cannot drift from what
// the application actually binds — and now that bindings are editable, "cannot
// drift" includes the user's own choices: every key shown here is read from the
// same resolved table the global listener matches against.
//
// Pointer-only routes are listed beside the verbs that have no key, which is what
// makes it safe for a control to be summoned rather than permanent.

import { Dialog } from "../../ui/components";
import { Kbd } from "../../ui/kbd";
import { useI18n } from "../../i18n";
import { formatBindingParts, useShortcutBindings, type ShortcutId } from "./shortcuts";

interface Entry {
  label: string;
  /** One entry per key or combination; each is the parts `<Kbd>` lays out. */
  keys?: string[][];
  route?: string;
}

interface Section {
  title: string;
  entries: Entry[];
}

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const { message } = useI18n();
  const bindings = useShortcutBindings();
  const key = (id: ShortcutId) => formatBindingParts(bindings[id]);
  const keyText = (id: ShortcutId) => key(id).join("");

  const sections: Section[] = [
    {
      title: message("shortcuts.anywhere"),
      entries: [
        { label: message("shortcuts.search"), keys: [key("palette")] },
        { label: message("shortcuts.properties"), keys: [key("properties")] },
        { label: message("shortcuts.keyboard"), keys: [key("shortcuts")] },
        { label: message("shortcuts.sidebar"), keys: [key("sidebar")] },
        { label: message("shortcuts.settings"), keys: [key("settings")] },
        { label: message("shortcuts.undo"), keys: [key("undo")] },
        { label: message("shortcuts.redo"), keys: [key("redo")] },
        {
          label: message("shortcuts.customise"),
          route: message("shortcuts.customiseRoute"),
        },
      ],
    },
    {
      title: message("shortcuts.writing"),
      entries: [
        { label: message("shortcuts.newBlock"), keys: [["⏎"]] },
        { label: message("shortcuts.lineBreak"), keys: [["⇧", "⏎"]] },
        { label: message("shortcuts.indent"), keys: [["⇥"]] },
        { label: message("shortcuts.outdent"), keys: [["⇧", "⇥"]] },
        { label: message("shortcuts.moveUp"), keys: [["⌥", "↑"]] },
        { label: message("shortcuts.moveDown"), keys: [["⌥", "↓"]] },
        { label: message("shortcuts.nextPrevBlock"), keys: [["↑"], ["↓"]] },
        { label: message("shortcuts.collapseParent"), keys: [["←"]] },
        { label: message("shortcuts.expandChild"), keys: [["→"]] },
        { label: message("shortcuts.deleteBlock"), keys: [["⌫"]] },
        {
          label: message("shortcuts.blockActions"),
          route: message("shortcuts.blockActionsRoute"),
        },
        { label: message("shortcuts.tags"), route: message("shortcuts.tagsRoute") },
      ],
    },
    {
      title: message("shortcuts.selection"),
      entries: [
        {
          label: message("shortcuts.selectBlocks"),
          route: message("shortcuts.selectBlocksRoute"),
        },
        {
          label: message("shortcuts.moveSelection"),
          route: message("shortcuts.moveSelectionRoute"),
        },
        { label: message("shortcuts.deleteSelection"), keys: [["⌫"]] },
        { label: message("shortcuts.indent"), keys: [["⇥"]] },
        { label: message("shortcuts.outdent"), keys: [["⇧", "⇥"]] },
        { label: message("outline.clearSelection"), keys: [["⎋"]] },
      ],
    },
    {
      title: message("shortcuts.journalPages"),
      entries: [
        {
          label: message("shortcuts.jumpDate"),
          route: message("shortcuts.dateExamples", { key: keyText("palette") }),
        },
        {
          label: message("shortcuts.nextPrevDay"),
          route: message("shortcuts.nextPrevDayRoute"),
        },
        { label: message("shortcuts.newPage"), route: message("shortcuts.newPageRoute") },
        {
          label: message("shortcuts.renamePage"),
          route: message("shortcuts.renamePageRoute"),
        },
        {
          label: message("shortcuts.deletePage"),
          route: message("shortcuts.deletePageRoute"),
        },
        {
          label: message("shortcuts.pageDetails"),
          route: message("shortcuts.pageDetailsRoute"),
        },
      ],
    },
    {
      title: message("shortcuts.graph"),
      entries: [
        {
          label: message("shortcuts.switchGraph"),
          route: message("shortcuts.switchGraphRoute"),
        },
        {
          label: message("shortcuts.graphSettings"),
          route: message("shortcuts.graphSettingsRoute", { key: keyText("settings") }),
        },
      ],
    },
  ];

  return (
    <Dialog title={message("shortcuts.title")} onClose={onClose} size="wide">
      <div className="shortcuts" data-testid="shortcut-sheet">
        {sections.map((section) => (
          <section key={section.title}>
            <h3>{section.title}</h3>
            <dl>
              {section.entries.map((entry) => (
                <div key={entry.label} className="contents">
                  <dt>{entry.label}</dt>
                  <dd>
                    {entry.keys
                      ? entry.keys.map((parts) => (
                          <Kbd key={parts.join("")} parts={parts} />
                        ))
                      : entry.route}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </Dialog>
  );
}
