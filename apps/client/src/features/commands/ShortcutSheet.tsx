// The ⌘/ sheet. Generated from one table so it cannot drift from what the
// application actually binds, including pointer-only routes.

import { Dialog } from "../../ui/components";
import { useI18n } from "../../i18n";
import { MOD } from "./keys";

interface Entry {
  label: string;
  keys?: string[];
  route?: string;
}

interface Section {
  title: string;
  entries: Entry[];
}

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  const { message } = useI18n();
  const sections: Section[] = [
    {
      title: message("shortcuts.anywhere"),
      entries: [
        { label: message("shortcuts.search"), keys: [`${MOD}K`] },
        { label: message("shortcuts.properties"), keys: [`${MOD}⇧P`] },
        { label: message("shortcuts.keyboard"), keys: [`${MOD}/`] },
        { label: message("shortcuts.sidebar"), keys: [`${MOD}\\`] },
        { label: message("shortcuts.settings"), keys: [`${MOD},`] },
        { label: message("shortcuts.undo"), keys: [`${MOD}Z`] },
        { label: message("shortcuts.redo"), keys: [`${MOD}⇧Z`] },
      ],
    },
    {
      title: message("shortcuts.writing"),
      entries: [
        { label: message("shortcuts.newBlock"), keys: ["⏎"] },
        { label: message("shortcuts.lineBreak"), keys: ["⇧⏎"] },
        { label: message("shortcuts.indent"), keys: ["⇥"] },
        { label: message("shortcuts.outdent"), keys: ["⇧⇥"] },
        { label: message("shortcuts.moveUp"), keys: ["⌥↑"] },
        { label: message("shortcuts.moveDown"), keys: ["⌥↓"] },
        { label: message("shortcuts.nextPrevBlock"), keys: ["↑", "↓"] },
        { label: message("shortcuts.collapseParent"), keys: ["←"] },
        { label: message("shortcuts.expandChild"), keys: ["→"] },
        { label: message("shortcuts.deleteBlock"), keys: ["⌫"] },
        {
          label: message("shortcuts.blockActions"),
          route: message("shortcuts.blockActionsRoute"),
        },
        { label: message("shortcuts.tags"), route: message("shortcuts.tagsRoute") },
      ],
    },
    {
      title: message("shortcuts.journalPages"),
      entries: [
        {
          label: message("shortcuts.jumpDate"),
          route: message("shortcuts.dateExamples", { key: `${MOD}K` }),
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
          route: message("shortcuts.graphSettingsRoute", { key: `${MOD},` }),
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
                      ? entry.keys.map((key) => (
                          <kbd className="kbd" key={key}>
                            {key}
                          </kbd>
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
