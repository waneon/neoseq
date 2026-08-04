// The ⌘/ sheet. Generated from one table so it cannot drift from what the
// application actually binds, and it deliberately lists the verbs that have NO
// binding together with their pointer route — a shortcut reference that only
// mentions shortcuts teaches half the interface.

import { Dialog } from "../../ui/components";
import { MOD } from "./keys";

interface Entry {
  label: string;
  keys?: string[];
  route?: string;
}

const SECTIONS: { title: string; entries: Entry[] }[] = [
  {
    title: "Anywhere",
    entries: [
      { label: "Search pages, dates and commands", keys: [`${MOD}K`] },
      { label: "Properties of this block or page", keys: [`${MOD}⇧P`] },
      { label: "Keyboard shortcuts", keys: [`${MOD}/`] },
      { label: "Show or hide the sidebar", keys: [`${MOD}\\`] },
      { label: "Settings", keys: [`${MOD},`] },
      { label: "Undo", keys: [`${MOD}Z`] },
      { label: "Redo", keys: [`${MOD}⇧Z`] },
    ],
  },
  {
    title: "Writing",
    entries: [
      { label: "New block", keys: ["⏎"] },
      { label: "Line break inside a block", keys: ["⇧⏎"] },
      { label: "Indent", keys: ["⇥"] },
      { label: "Outdent", keys: ["⇧⇥"] },
      { label: "Move block up", keys: ["⌥↑"] },
      { label: "Move block down", keys: ["⌥↓"] },
      { label: "Previous or next block", keys: ["↑", "↓"] },
      { label: "Collapse, then jump to the parent", keys: ["←"] },
      { label: "Expand, then jump to the first child", keys: ["→"] },
      { label: "Delete an empty block", keys: ["⌫"] },
      { label: "Block actions", route: "the ⋯ on the row, or right-click it" },
      { label: "Add or remove a tag", route: "row ⋯ → Properties & tags" },
    ],
  },
  {
    title: "Journal and pages",
    entries: [
      {
        label: "Jump to a date",
        route: `${MOD}K, then type “tomorrow”, “aug 5” or “2026-08-05”`,
      },
      { label: "Previous or next day", route: "the ‹ › beside the journal title" },
      { label: "New page", route: "the ＋ beside Pages in the sidebar" },
      { label: "Rename a page", route: "click its title" },
      { label: "Delete a page", route: "page ⋯ → Delete page" },
      { label: "Page details", route: "page ⋯ → Page info" },
    ],
  },
  {
    title: "Graph",
    entries: [
      { label: "Switch or rename a graph", route: "the graph name at the top of the sidebar" },
      { label: "Appearance, timezone, storage", route: `Settings (${MOD},)` },
    ],
  },
];

export function ShortcutSheet({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title="Keyboard shortcuts" onClose={onClose} size="wide">
      <div className="shortcuts" data-testid="shortcut-sheet">
        {SECTIONS.map((section) => (
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
