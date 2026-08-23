import { expect, test, type Page } from "@playwright/test";
import {
  awaitSaved,
  createGraph,
  createPage,
  openBlockProperties,
  openBlockTags,
  openPageMenu,
  openPageProperties,
  openSidebar,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";

async function addCustom(
  page: Page,
  key: string,
  type: "string" | "number" | "checkbox" | "date" | "page",
  value: string,
): Promise<void> {
  // A user property is typed and read by its bare name; user. is storage routing.
  const name = key.replace(/^user\./u, "");
  await openPageProperties(page);
  const picker = page.getByTestId("property-picker");
  await picker.getByLabel("Property key").fill(name);
  await picker.getByRole("option", { name: `Create property “${name}”` }).click();
  await picker.getByRole("option", { name: type, exact: true }).click();
  if (type === "checkbox") {
    await picker.getByRole("option", { name: value === "yes" ? "Checked" : "Unchecked", exact: true }).click();
  } else if (type === "page") {
    await picker.getByTestId("page-autocomplete").fill(value);
    await page.getByRole("option", { name: "Everything", exact: true }).click();
  } else if (type === "date") {
    // The platform's own date input commits the moment it holds a full date.
    await picker.getByLabel("Pick a date").fill(value);
  } else {
    await picker.getByLabel(`${name} value`).fill(value);
    await picker.getByTestId("property-set").click();
  }
  await expect(picker).toHaveCount(0);
  await awaitSaved(page);
}

test("edits every value type plus unknown keys in the contextual picker", async ({ page }) => {
  await createGraph(page, "Props Graph");
  await createPage(page, "Everything");

  await addCustom(page, "user.text", "string", "hello");
  await addCustom(page, "user.count", "number", "42");
  await addCustom(page, "user.done", "checkbox", "yes");
  await addCustom(page, "user.when", "date", "2026-08-03");
  await addCustom(page, "user.ref", "page", "Every");

  await page.getByTestId("prop-user.text").click();
  let picker = page.getByTestId("property-picker");
  await picker.getByLabel("text value").fill("updated");
  await picker.getByTestId("property-set").click();
  await awaitSaved(page);
  await page.reload();
  await expect(page.getByTestId("prop-user.text")).toContainText("updated");
  await page.getByRole("button", { name: "+1 more" }).click();
  picker = page.getByTestId("property-picker");

  // The compact strip deliberately exposes only four entries and storage does
  // not promise insertion order. Verify persisted values through the canonical
  // picker, which lists every existing property first.
  await picker.getByRole("option", { name: /count/ }).click();
  await expect(picker).toContainText("42");
  await page.keyboard.press("Escape");
  await picker.getByRole("option", { name: /done/ }).click();
  await expect(picker).toContainText("Checked");
  await page.keyboard.press("Escape");
  await picker.getByRole("option", { name: /when/ }).click();
  await expect(picker).toContainText("2026-08-03");
  await page.keyboard.press("Escape");
  await picker.getByRole("option", { name: /ref/ }).click();
  await expect(picker).toContainText("Everything");
  await page.keyboard.press("Escape");
  await picker.getByRole("option", { name: /count/ }).click();
  await picker.getByRole("button", { name: "Remove property" }).click();
  await openPageProperties(page);
  await page.getByTestId("property-picker").getByLabel("Property key").fill("user.count");
  await expect(page.getByRole("option", { name: "Create property “count”" })).toBeVisible();
});

test("rejects property keys outside the owned namespaces with a visible validation error", async ({ page }) => {
  await createGraph(page, "Validation Graph");
  await createPage(page, "Rules");
  await openPageProperties(page);
  const picker = page.getByTestId("property-picker");
  // A bare name would become user.tag; only a malformed dotted key is a dead end.
  await picker.getByLabel("Property key").fill("user.Bad!");
  await expect(picker.getByTestId("props-error")).toContainText(
    "must use builtin.* or user.*",
  );
});

test("slash, block properties, and tags share the same focused target", async ({ page }) => {
  await createGraph(page, "Tag Graph");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Tags" }).click();
  await page.getByTestId("new-tag").click();
  await page.getByTestId("new-tag-name").fill("Project");
  await page.getByTestId("new-tag-name").press("Enter");
  await expect(page.getByTestId("tag-row")).toContainText("#Project");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Journal" }).click();
  await startOutline(page);
  await page.getByLabel("Block text").pressSequentially("/pro");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await page.keyboard.press("Enter");

  let picker = page.getByTestId("property-picker");
  await picker.getByRole("option", { name: "Status", exact: true }).click();
  await picker.getByRole("option", { name: "Doing", exact: true }).click();
  await expect(page.getByTestId("task-status-toggle")).toHaveAccessibleName("Task status: Doing");
  await expect(page.getByLabel("Block text")).toHaveValue("");

  await openBlockTags(page);
  let tags = page.getByTestId("tag-picker");
  await tags.getByTestId("tag-autocomplete").fill("Project");
  await page.getByRole("option", { name: "Project", exact: true }).click();
  await expect(tags.getByTestId("tag-chip")).toContainText("#Project");
  await page.keyboard.press("Escape");
  await expect(tags).toHaveCount(0);

  const text = page.getByLabel("Block text").first();
  await text.click();
  await text.press("End");
  await text.press("Enter");
  await typeInFocusedBlock(page, "fresh block");
  await openBlockTags(page, 1);
  tags = page.getByTestId("tag-picker");
  await tags.getByTestId("tag-autocomplete").fill("Proj");
  await page.getByRole("option", { name: "Project", exact: true }).click();
  await expect(tags.getByTestId("tag-chip")).toContainText("#Project");
  await tags.getByRole("button", { name: "Remove tag Project" }).click();
  await expect(tags.getByTestId("tag-chip")).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(tags).toHaveCount(0);
  await openBlockProperties(page, 1);
  picker = page.getByTestId("property-picker");
  await expect(picker.getByLabel("Property key")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);

  await page.getByLabel("Block text").nth(1).click();
  await page.keyboard.press("ControlOrMeta+P");
  picker = page.getByTestId("property-picker");
  await expect(picker.getByLabel("Property key")).toBeFocused();
});

test("a tag under a block is an accent reference that leads to the tag, never a delete", async ({
  page,
}) => {
  await createGraph(page, "Tag Reference Graph");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Tags" }).click();
  await page.getByTestId("new-tag").click();
  await page.getByTestId("new-tag-name").fill("Design");
  await page.getByTestId("new-tag-name").press("Enter");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Journal" }).click();
  await startOutline(page);
  await typeInFocusedBlock(page, "the tag is a reference");
  await openBlockTags(page);
  await page.getByTestId("tag-picker").getByTestId("tag-autocomplete").fill("Design");
  await page.getByRole("option", { name: "Design", exact: true }).click();
  await page.keyboard.press("Escape");
  await awaitSaved(page);

  const chip = page.locator(".outline-tags").getByTestId("tag-chip");
  await expect(chip).toContainText("#Design");
  // A tag is the one thing in the writing that leads somewhere, so it carries the
  // accent's hue — but not the accent's own strength. `--accent` is tuned for a
  // mark; on a run of words inside a sentence it shouted, so the tag takes the
  // same hue with the chroma pulled back (§ The accent, spoken quietly).
  const tones = await chip.evaluate((node) => {
    const resolve = (value: string) => {
      const probe = document.createElement("span");
      probe.style.color = value;
      document.body.append(probe);
      const resolved = getComputedStyle(probe).color;
      probe.remove();
      return resolved;
    };
    return {
      chip: getComputedStyle(node).color,
      quiet: resolve("var(--accent-quiet)"),
      accent: resolve("var(--accent)"),
    };
  });
  expect(tones.chip).toBe(tones.quiet);
  expect(tones.chip).not.toBe(tones.accent);

  // …and pressing it goes to the tag, rather than silently detaching the name the
  // reader just wrote. The one thing on a line shaped like a link leads somewhere.
  await chip.click();
  await expect(page.getByTestId("tag-title")).toHaveValue("Design");
  await expect(page.getByTestId("query-block")).toHaveAttribute("data-variant", "page");

  // Writing tags keeps its own pointer route on the bullet's menu, where a
  // destructive verb belongs.
  await page.goBack();
  await openBlockTags(page);
  const picker = page.getByTestId("tag-picker");
  await expect(picker.getByTestId("tag-chip")).toContainText("#Design");
  await picker.getByRole("button", { name: "Remove tag Design" }).click();
  await expect(page.locator(".outline-tags")).toHaveCount(0);
});

// What a reader keeps to hand: one checkbox on the thing itself, and one list in
// the rail that shows pages and tags together, because "the things I come back
// to" is one thought.
test("a starred page and a starred tag share one list in the rail", async ({ page }) => {
  await createGraph(page, "Favourites Graph");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Tags" }).click();
  await page.getByTestId("new-tag").click();
  await page.getByTestId("new-tag-name").fill("Reading");
  await page.getByTestId("new-tag-name").press("Enter");
  await page.keyboard.press("Escape");
  await createPage(page, "Reading list");

  // Nothing starred, nothing said: an empty heading is a promise the rail has
  // not been asked to keep.
  await expect(page.getByTestId("favourite-list")).toHaveCount(0);

  await openPageMenu(page);
  await page.getByTestId("menu-page-favourite").click();
  await awaitSaved(page);
  await expect(page.getByTestId("favourite-item")).toHaveText(["Reading list"]);

  await page.getByTestId("sidebar").getByRole("link", { name: "Tags" }).click();
  await page.getByTestId("tag-row-menu").click();
  await page.getByTestId("tag-row-favourite").click();
  await awaitSaved(page);
  await expect(page.getByTestId("favourite-item")).toHaveText(["#Reading", "Reading list"]);

  // The order is the reader's, not the alphabet's: the page is dragged above the
  // tag, and the seam says where it will land before it lands.
  const items = page.getByTestId("favourite-item");
  // Matched whole, because "Reading list" contains the tag's name.
  const tag = items.filter({ hasText: /^#Reading$/ });
  const list = items.filter({ hasText: /^Reading list$/ });
  await list.dragTo(tag, { targetPosition: { x: 20, y: 2 } });
  await awaitSaved(page);
  await expect(items).toHaveText(["Reading list", "#Reading"]);

  // …and the same move from a keyboard, because a rail row is a link and a
  // reorder no keyboard can reach is a reorder half the readers do not have.
  await list.focus();
  await page.keyboard.press("Alt+ArrowDown");
  await awaitSaved(page);
  await expect(items).toHaveText(["#Reading", "Reading list"]);

  // The arrangement is the graph's, not this browser's, so a reload finds it.
  await page.reload();
  await openSidebar(page);
  await expect(items).toHaveText(["#Reading", "Reading list"]);

  // …and the same row takes it back, saying so in its own label.
  await page.getByTestId("tag-row-menu").click();
  await expect(page.getByTestId("tag-row-favourite")).toHaveText("Remove from favourites");
  await page.getByTestId("tag-row-favourite").click();
  await expect(page.getByTestId("favourite-item")).toHaveText(["Reading list"]);
});

// Groups, marks, and colours: everything the manager exists for, from the one
// panel a tag's mark opens — and the drag that is the other way to file one.
test("tags are filed into groups, marked, and coloured from one panel", async ({ page }) => {
  await createGraph(page, "Tag Manager Graph");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Tags" }).click();
  for (const name of ["Design", "Reading", "Errands"]) {
    await page.getByTestId("new-tag").click();
    await page.getByTestId("new-tag-name").fill(name);
    await page.getByTestId("new-tag-name").press("Enter");
  }
  await page.keyboard.press("Escape");
  // One heading for the only group there could be says nothing, so there is none.
  await expect(page.getByTestId("tag-group-name")).toHaveCount(0);

  const design = page.getByTestId("tag-row").filter({ hasText: "Design" });
  await design.getByTestId("tag-mark").click();
  const panel = page.getByTestId("tag-identity");
  await panel.getByTestId("tag-colour-teal").click();
  await panel.getByRole("button", { name: "🎨", exact: true }).click();
  await panel.getByTestId("tag-group-field").fill("Areas");
  await panel.getByTestId("tag-group-field").press("Enter");
  await page.keyboard.press("Escape");
  await awaitSaved(page);

  // The mark is the tag's own: its emoji, in its own hue, wherever it appears.
  await expect(design.getByTestId("tag-mark")).toHaveText("🎨");
  await expect(design.getByTestId("tag-mark")).toHaveAttribute("data-hue", "teal");
  await expect(page.getByTestId("tag-group-name")).toHaveText(["Areas", "Ungrouped"]);

  // Filing by drag: the gesture everybody already knows.
  const reading = page.getByTestId("tag-row").filter({ hasText: "Reading" });
  await reading.dragTo(design);
  await awaitSaved(page);
  await expect(
    page.locator(".tag-group").filter({ hasText: "Areas" }).getByTestId("tag-row"),
  ).toHaveCount(2);

  // The order inside a group is the reader's, and a drag says where it lands
  // before it lands: one seam, and nothing reflows until the drop.
  const areas = page.locator(".tag-group").filter({ hasText: "Areas" });
  await expect(areas.getByTestId("tag-row-link")).toHaveText(["Design", "Reading"]);
  await reading.dragTo(design, { targetPosition: { x: 20, y: 2 } });
  await awaitSaved(page);
  await expect(areas.getByTestId("tag-row-link")).toHaveText(["Reading", "Design"]);

  await expect(page.getByTestId("tag-group-name")).toHaveText(["Areas", "Ungrouped"]);

  // A group is the name its members carry, so renaming it is rewriting them and
  // emptying it is the group ceasing to exist.
  await areas.getByTestId("tag-group-menu").click();
  await page.getByTestId("tag-group-rename").click();
  await page.getByTestId("tag-group-rename-field").fill("Practices");
  await page.getByTestId("tag-group-rename-field").press("Enter");
  await expect(page.getByTestId("tag-group-name")).toHaveText(["Practices", "Ungrouped"]);
  await awaitSaved(page);

  const practices = page.locator(".tag-group").filter({ hasText: "Practices" });
  await practices.getByTestId("tag-group-menu").click();
  await page.getByTestId("tag-group-ungroup").click();
  await expect(page.getByTestId("tag-group-name")).toHaveCount(0);
  await expect(page.getByTestId("tag-row")).toHaveCount(3);
});

// A tag is a place now: its name, its defaults, and the query that answers what
// it is for all live on one route, and that query's saved views are the page's
// own tabs. Nothing is written until something is shaped.
test("a tag's page carries its query, and the query's views are its tabs", async ({ page }) => {
  await createGraph(page, "Tag Page Graph");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Tags" }).click();
  await page.getByTestId("new-tag").click();
  await page.getByTestId("new-tag-name").fill("Reading");
  await page.getByTestId("new-tag-name").press("Enter");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Journal" }).click();
  await startOutline(page);
  await typeInFocusedBlock(page, "finish the Loro paper");
  await openBlockTags(page);
  await page.getByTestId("tag-picker").getByTestId("tag-autocomplete").fill("Reading");
  await page.getByRole("option", { name: "Reading", exact: true }).click();
  await page.keyboard.press("Escape");
  await awaitSaved(page);

  await page.locator(".outline-tags").getByTestId("tag-chip").click();
  await expect(page.getByTestId("tag-title")).toHaveValue("Reading");
  // The seeded query answers what the tag is for, without anyone writing it.
  const query = page.getByTestId("query-block");
  await expect(query.getByTestId("query-summary")).toContainText("#Reading");
  await expect(query.getByTestId("query-count")).toContainText("1 result");
  await expect(query.getByTestId("query-table")).toBeVisible();

  // One view, named for what it shows rather than for how it is drawn — and the
  // chosen tab is raised out of the track rather than told apart by a second
  // signal (DESIGN.md § Interaction States).
  const tabs = query.getByRole("tab");
  await expect(tabs).toHaveText(["All"]);
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");

  // A view's stored name is authoritative even when it carries the initial
  // stable ID. Renaming changes the name, not the identity.
  await tabs.first().click({ button: "right" });
  await page.getByTestId("query-view-rename").click();
  await query.getByTestId("query-view-rename-field").fill("Everything");
  await query.getByTestId("query-view-rename-field").press("Enter");
  await expect(query.getByRole("tab", { name: "Everything" })).toBeVisible();
  await awaitSaved(page);

  // A new view opens on itself, and is renamed where it stands.
  await query.getByTestId("query-view-add").click();
  await page.getByRole("menuitem", { name: "List", exact: true }).click();
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveText("List");
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(query.getByTestId("query-list")).toBeVisible();
  await awaitSaved(page);
  await tabs.nth(1).click({ button: "right" });
  await page.getByTestId("query-view-rename").click();
  const field = query.getByTestId("query-view-rename-field");
  await field.fill("Unread");
  await field.press("Enter");
  await expect(query.getByRole("tab", { name: "Unread" })).toBeVisible();
  await awaitSaved(page);

  // And the order survives a reload, because a view is graph data.
  await page.reload();
  await expect(query.getByRole("tab", { name: "Unread" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(query.getByRole("tab", { name: "Everything" })).toBeVisible();

  // Dragging a tab past its neighbour is the same move the menu makes.
  await query.getByRole("tab", { name: "Unread" }).dragTo(
    query.getByRole("tab", { name: "Everything" }),
    { targetPosition: { x: 2, y: 10 } },
  );
  await awaitSaved(page);
  await expect(query.getByRole("tab")).toHaveText(["Unread", "Everything"]);

  await query.getByRole("tab", { name: "Unread" }).click({ button: "right" });
  await page.getByTestId("query-view-delete").click();
  await expect(query.getByRole("tab")).toHaveText(["Everything"]);
});

test("deleted page references resolve to a tombstone, not a new page", async ({ page }) => {
  await createGraph(page, "Tombstone Graph");
  await createPage(page, "Ephemeral");
  await startOutline(page);
  await typeInFocusedBlock(page, "content to restore");

  await openPageMenu(page);
  await page.getByTestId("delete-page").click();
  await page.getByTestId("confirm-delete-page").click();
  await expect(page.getByTestId("tombstone")).toBeVisible();
  await expect(page.getByTestId("page-list").getByRole("link", { name: "Ephemeral" }))
    .toHaveCount(0);

  await page.getByTestId("restore-page").click();
  await expect(page.getByTestId("page-title")).toHaveValue("Ephemeral");
  await expect(page.locator('[data-testid="outline-row"] textarea').first()).toHaveValue(
    "content to restore",
  );
});
