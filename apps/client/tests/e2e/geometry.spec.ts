// The geometry gate.
//
// This file is the reason a glyph is not centred on a half pixel, two stacked
// things do not nearly share a left edge, a row does not shift when the pointer
// arrives, four sibling grids agree on their columns, and nothing ellipsises with
// no way to read the rest. Every one of those was a real defect in this codebase
// on 2026-08-21; each is invisible in a code review and obvious on screen, and
// each would come back the moment somebody wrote `15px` in a 24px box.
//
// It measures rather than compares images: a screenshot baseline tells you that
// something changed, and this tells you what is wrong with it.
import { expect, test } from "@playwright/test";
import {
  awaitSaved,
  chooseFromMenu,
  createGraph,
  createPage,
  openBlockMenu,
  openBlockProperties,
  openBlockTags,
  openPageProperties,
  openSettings,
  openSidebar,
  startOutline,
  typeInFocusedBlock,
} from "./helpers";
import type { Page } from "@playwright/test";

const AUDIT = /* language=JavaScript */ `
(() => {
  const findings = [];
  const seen = new Set();
  const add = (kind, detail) => {
    const key = kind + "|" + detail;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push(kind + ": " + detail);
  };
  const frac = (n) => {
    const f = Math.abs(n - Math.round(n));
    return f > 0.02 && f < 0.98 ? f : 0;
  };
  const name = (el) => {
    if (!el) return "?";
    const id = el.dataset && el.dataset.testid ? "[" + el.dataset.testid + "]" : "";
    const cls = typeof el.className === "string" && el.className
      ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".")
      : "";
    return el.tagName.toLowerCase() + cls + id;
  };
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  // The journal's native date input is deliberately 1px and clip-path'd: it is a
  // real tab stop that states nothing on screen. It is not a layout defect.
  //
  // The bullet is deliberately a 24px target in a 20px slot
  // (designs/outliner.md § Blocks and Editing), so its slot reports 2px of
  // overflow by design.
  const excluded = (el) => el.closest(".clipped-control, .sr-only, .outline-gutter") !== null;
  const all = [...document.querySelectorAll("body *")].filter((el) => visible(el) && !excluded(el));
  for (const el of all) {
    if (getComputedStyle(el).position === "fixed") el.classList.add("fixed-layer");
  }

  // 1. A glyph centred on a half pixel inside its own box. Offsets are measured
  //    against the parent, so a page that happens to sit at a fractional x does
  //    not make every icon on it look like a bug.
  for (const svg of all.filter((e) => e.tagName.toLowerCase() === "svg")) {
    const parent = svg.parentElement;
    if (!parent) continue;
    const s = svg.getBoundingClientRect();
    const p = parent.getBoundingClientRect();
    const ps = getComputedStyle(parent);
    const siblingText = [...parent.childNodes].some(
      (n) => n.nodeType === 3 && n.textContent && n.textContent.trim(),
    );
    const centresCluster =
      ps.justifyContent === "center" &&
      ([...parent.children].filter(visible).length > 1 || siblingText);
    // A control as wide as its own text puts everything after that text on a
    // sub-pixel, and no amount of CSS rounds a glyph run. Only the axis whose
    // box size the product actually chose can be a defect: an integer-width box
    // that centres a glyph off-centre is one, an inherited fraction is not.
    const dx = centresCluster || frac(p.width) ? 0 : frac(s.left - p.left);
    const dy = frac(p.height) ? 0 : frac(s.top - p.top);
    if (dx || dy) {
      add(
        "half-pixel-glyph",
        name(parent) + " > svg " + Math.round(s.width) + "x" + Math.round(s.height) +
          " offset " + (s.left - p.left).toFixed(2) + "," + (s.top - p.top).toFixed(2) +
          " in " + Math.round(p.width) + "x" + Math.round(p.height),
      );
    }
    if (frac(s.width) || frac(s.height)) {
      add("fractional-glyph-size", name(parent) + " > svg " + s.width.toFixed(2) + "x" + s.height.toFixed(2));
    }
  }

  // 2. A child that is not vertically centred in the row that says it centres.
  for (const el of all) {
    const s = getComputedStyle(el);
    if (s.display !== "flex" && s.display !== "inline-flex") continue;
    if (s.alignItems !== "center") continue;
    if (s.flexDirection.startsWith("column")) continue;
    const r = el.getBoundingClientRect();
    if (r.height < 8) continue;
    const kids = [...el.children].filter(visible);
    // A wrapped row has no single centre line: its children sit on two or more
    // flex lines and each is centred on its own. Comparing them to the
    // container's middle reports correct layout as a defect.
    //
    // Bare text counts. A callout whose sentence is a text node and whose verb is
    // a button has one element child and two flex items, and looking only at
    // elements makes the button's honest second-line position read as 16px of
    // sloppiness.
    const boxes = kids.map((k) => k.getBoundingClientRect());
    for (const node of el.childNodes) {
      if (node.nodeType !== 3 || !node.textContent || !node.textContent.trim()) continue;
      const range = document.createRange();
      range.selectNode(node);
      const r = range.getBoundingClientRect();
      if (r.height > 0) boxes.push(r);
    }
    const wrapped = boxes.some((a) => boxes.some((b) => a.bottom <= b.top + 0.5));
    if (wrapped) continue;
    const mid = r.top + r.height / 2;
    for (const child of kids) {
      const c = child.getBoundingClientRect();
      if (c.height >= r.height - 1) continue; // fills the row; nothing to centre
      const off = c.top + c.height / 2 - mid;
      if (Math.abs(off) > 0.51) {
        add(
          "off-centre",
          name(el) + " > " + name(child) + " is " + off.toFixed(2) + "px off the row's centre line",
        );
      }
    }
  }

  // 3. Two things stacked in the same column whose text nearly starts at the
  //    same x. A difference of zero is alignment and a large one is a deliberate
  //    indent; anything in between is a mistake nobody meant to make.
  //
  //    The measurement is the *first glyph*, taken from a Range, not the
  //    element's box: a textarea with 4px of padding and a heading with none are
  //    aligned on screen while their boxes are 4px apart, and comparing boxes
  //    reports the alignment as the bug.
  const glyphLeft = (el) => {
    if (["INPUT", "TEXTAREA"].includes(el.tagName)) {
      const s = getComputedStyle(el);
      return el.getBoundingClientRect().left + parseFloat(s.paddingLeft) + parseFloat(s.borderLeftWidth);
    }
    for (const node of el.childNodes) {
      if (node.nodeType !== 3 || !node.textContent || !node.textContent.trim()) continue;
      const range = document.createRange();
      const text = node.textContent;
      const start = text.length - text.trimStart().length;
      range.setStart(node, start);
      range.setEnd(node, Math.min(start + 1, text.length));
      const r = range.getBoundingClientRect();
      if (r.width > 0 || r.height > 0) return r.left;
    }
    return null;
  };
  // Only the *start of a line* has a left edge worth comparing. Something that
  // follows content in its own row is positioned by that content, and something
  // in a grid's second column is positioned by the first — neither is a column
  // edge, and treating them as one reports every inline sentence as a defect.
  //
  // A *field* is content. An input has no text content, so a row reading
  // "[ 100 ] (x) Unique rows" used to call the checkbox's label a line start,
  // and then reported the 1.67px between it and the second control of the
  // clause above as a near miss — two unrelated columns compared for the one
  // reason this predicate exists to rule out.
  const contentful = (el) =>
    ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName) ||
    Boolean(el.textContent && el.textContent.trim());
  const lineStart = (el) => {
    const parent = el.parentElement;
    if (!parent) return true;
    const ps = getComputedStyle(parent);
    const rowish =
      (ps.display.includes("flex") && !ps.flexDirection.startsWith("column")) ||
      ps.display.includes("grid");
    if (!rowish) return true;
    const left = el.getBoundingClientRect().left;
    for (const sib of [...parent.children]) {
      if (sib === el) break;
      if (!visible(sib)) continue;
      if (!contentful(sib)) continue;
      if (sib.getBoundingClientRect().right <= left + 0.5) return false;
    }
    return true;
  };
  const texty = all.filter((el) => {
    if (["SVG", "PATH", "BR", "SCRIPT", "STYLE"].includes(el.tagName)) return false;
    // A key badge is a cluster of one-character columns whose widths are the
    // characters'; two badges never line up and are not meant to.
    if (el.closest(".kbd")) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 6) return false;
    const direct = [...el.childNodes].some(
      (n) => n.nodeType === 3 && n.textContent && n.textContent.trim().length > 0,
    );
    const field = ["INPUT", "TEXTAREA"].includes(el.tagName);
    if (!(direct || field)) return false;
    return lineStart(el);
  }).map((el) => ({ el, x: glyphLeft(el), r: el.getBoundingClientRect() }))
    .filter((entry) => entry.x !== null);
  for (let i = 0; i < texty.length; i += 1) {
    for (let j = i + 1; j < texty.length; j += 1) {
      const a = texty[i];
      const b = texty[j];
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      // A portaled overlay floats over the page; its left edge has nothing to do
      // with the column beneath it.
      if (a.el.closest(".fixed-layer") !== b.el.closest(".fixed-layer")) continue;
      const dy = b.r.top - a.r.bottom;
      if (dy < -4 || dy > 90) continue; // not stacked near each other
      const dx = Math.abs(b.x - a.x);
      if (dx > 0.9 && dx < 7) {
        add(
          "near-miss-left-edge",
          name(a.el) + " glyph@" + a.x.toFixed(2) + " vs " + name(b.el) +
            " glyph@" + b.x.toFixed(2) + " — " + dx.toFixed(2) + "px apart",
        );
      }
    }
  }

  // 4. Content wider than a box that has no way to show it — and that a reader
  //    can therefore actually reach. A row that bleeds four pixels into its
  //    pane's own padding overflows its parent on paper and nothing on screen,
  //    so the test is whether the overflow survives as far as a scroller and
  //    makes that scroller scroll.
  for (const el of all) {
    const s = getComputedStyle(el);
    const scrolls = /(auto|scroll)/.test(s.overflowX + s.overflowY);
    if (scrolls) continue;
    if (s.overflowX === "hidden" || s.overflowY === "hidden") continue;
    if (!(el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0)) continue;
    let clipped = false;
    let scroller = null;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (/(hidden|clip)/.test(ps.overflowX)) { clipped = true; break; }
      if (/(auto|scroll)/.test(ps.overflowX)) { scroller = p; break; }
    }
    if (clipped) continue;
    if (scroller && scroller.scrollWidth <= scroller.clientWidth + 1) continue;
    add(
      "overflow-x",
      name(el) + " content " + el.scrollWidth + " > box " + el.clientWidth +
        (scroller ? " — scrolls " + name(scroller) : " — reaches the document"),
    );
  }

  // 5. Icons of different sizes inside one control cluster.
  for (const el of all) {
    const svgs = [...el.children].filter((c) => c.tagName.toLowerCase() === "svg");
    if (svgs.length < 2) continue;
    const sizes = new Set(svgs.map((s) => Math.round(s.getBoundingClientRect().width)));
    if (sizes.size > 1) add("mixed-icon-size", name(el) + " has " + [...sizes].join("/") + "px icons");
  }

  // 6. A fractional box on something that draws an edge: a hairline on a half
  //    pixel is a two-pixel grey smear. Only where the product chose the size —
  //    a box that is as wide as its own text is fractional in every web UI ever
  //    shipped, and rounding it would be the odder decision.
  for (const el of all) {
    const s = getComputedStyle(el);
    const draws = s.boxShadow !== "none" || s.borderTopWidth !== "0px" ||
      s.borderBottomWidth !== "0px" || s.borderLeftWidth !== "0px" || s.borderRightWidth !== "0px";
    if (!draws) continue;
    const r = el.getBoundingClientRect();
    // Inline runs are as wide as their own characters; that is not a decision
    // the product made and not one it should round.
    if (s.display.startsWith("inline")) continue;
    if (frac(r.height)) {
      add("fractional-edged-box", name(el) + " " + r.width.toFixed(2) + "x" + r.height.toFixed(2) +
        " (css " + s.width + " x " + s.height + ")");
    }
  }

  // 7. Text in one row that does not share a baseline. A label and the badge
  //    beside it sitting a pixel apart is the defect nobody can name and
  //    everybody sees.
  for (const el of all) {
    const s = getComputedStyle(el);
    if (s.display !== "flex" && s.display !== "inline-flex") continue;
    if (s.flexDirection.startsWith("column")) continue;
    const kids = [...el.children].filter(visible);
    // Same reason as the centring check: children on two flex lines sit on two
    // baselines, and that is what wrapping means.
    if (kids.some((a) => kids.some((b) =>
      a.getBoundingClientRect().bottom <= b.getBoundingClientRect().top + 0.5))) continue;
    const bases = [];
    for (const child of kids) {
      const node = [...child.childNodes].find(
        (n) => n.nodeType === 3 && n.textContent && n.textContent.trim(),
      );
      if (!node) continue;
      const range = document.createRange();
      range.selectNodeContents(child);
      const r = range.getBoundingClientRect();
      if (r.height < 4) continue;
      bases.push({ el: child, bottom: r.bottom, size: parseFloat(getComputedStyle(child).fontSize) });
    }
    if (bases.length < 2) continue;
    // Only compare runs at the same size: a 12px badge beside 14px text sits on
    // its own baseline on purpose when the row centres them.
    for (let i = 0; i < bases.length; i += 1) {
      for (let j = i + 1; j < bases.length; j += 1) {
        if (Math.abs(bases[i].size - bases[j].size) > 0.6) continue;
        const off = Math.abs(bases[i].bottom - bases[j].bottom);
        if (off > 0.6) {
          add(
            "baseline-mismatch",
            name(el) + ": " + name(bases[i].el) + " and " + name(bases[j].el) +
              " are " + off.toFixed(2) + "px apart at " + bases[i].size + "px",
          );
        }
      }
    }
  }

  // 8. A target smaller than the contract's floor.
  const floor = window.innerWidth <= 600 ? 32 : 24;
  for (const el of all) {
    const role = el.getAttribute("role");
    const pressable = ["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA"].includes(el.tagName) ||
      ["button", "option", "menuitem", "menuitemradio", "menuitemcheckbox", "tab", "link"].includes(role || "");
    if (!pressable) continue;
    if (el.tagName === "A" && el.classList.contains("skip-link")) continue;
    // A control wrapped in its own <label> is pressed by pressing the label.
    const label = el.closest("label");
    if (label && label !== el && Math.min(
      label.getBoundingClientRect().width,
      label.getBoundingClientRect().height,
    ) >= floor - 0.5) continue;
    const r = el.getBoundingClientRect();
    // A row-shaped control is as tall as its row and as wide as its list; only
    // the short side of a compact control is at issue.
    if (Math.min(r.width, r.height) < floor - 0.5 && r.width < 200) {
      add("small-target", name(el) + " " + Math.round(r.width) + "x" + Math.round(r.height) +
        " (floor " + floor + ")");
    }
  }

  // 9. A focus halo drawn inside a clipping ancestor is a focus halo with one
  //    edge missing.
  for (const el of all) {
    const s = getComputedStyle(el);
    if (!/0 0 0 3px|0 0 0 2px/.test(s.boxShadow)) continue;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const ps = getComputedStyle(p);
      if (!/(hidden|clip)/.test(ps.overflowX + ps.overflowY)) continue;
      const r = el.getBoundingClientRect();
      const pr = p.getBoundingClientRect();
      if (r.left - pr.left < 3 || pr.right - r.right < 3 || r.top - pr.top < 3 || pr.bottom - r.bottom < 3) {
        add("clipped-halo", name(el) + " inside clipping " + name(p));
      }
      break;
    }
  }

  // 10. Sibling grids that are meant to be rows of one table. Four rows sharing
  //     one grid-template-columns string are four independent grids: an auto or
  //     max-content track sizes to each row's own content, so the column they
  //     are supposed to form is ragged. Compared by class, because that is what
  //     "these are the same kind of row" means in this codebase.
  const families = new Map();
  for (const el of all) {
    if (!getComputedStyle(el).display.includes("grid")) continue;
    const cls = typeof el.className === "string" ? el.className.trim() : "";
    if (!cls) continue;
    const parent = el.parentElement;
    if (!parent) continue;
    const key = cls + "@" + (parent.className || parent.tagName);
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(el);
  }
  for (const [key, rows] of families) {
    if (rows.length < 2) continue;
    // Rows with different numbers of cells are different shapes: the nth child of
    // a three-cell row and of a four-cell row are not the same column, and
    // comparing them reports a difference that is the markup, not the layout.
    const byShape = new Map();
    for (const row of rows) {
      const shape = row.children.length;
      if (!byShape.has(shape)) byShape.set(shape, []);
      byShape.get(shape).push(row);
    }
    for (const [shape, group] of byShape) {
      if (group.length < 2) continue;
      for (let column = 0; column < shape; column += 1) {
        const lefts = group
          .map((row) => row.children[column])
          .filter((child) => child && visible(child))
          .map((child) => child.getBoundingClientRect().left);
        if (lefts.length < 2) continue;
        const spread = Math.max(...lefts) - Math.min(...lefts);
        if (spread > 0.6) {
          add(
            "ragged-grid-column",
            key + " cell " + column + " of " + shape + " spans " + spread.toFixed(2) +
              "px across " + lefts.length + " rows",
          );
        }
      }
    }
  }

  return findings;
})()
`;

const TRUNCATION = /* language=JavaScript */ `
(() => {
  const out = [];
  for (const el of document.querySelectorAll("body *")) {
    const s = getComputedStyle(el);
    if (s.textOverflow !== "ellipsis") continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    // Something is actually cut off. Is the whole of it reachable at all?
    const titled = el.title || el.getAttribute("aria-label") ||
      el.closest("[title]") !== null;
    if (!titled) {
      out.push(
        "truncated-unreadable: " + el.tagName.toLowerCase() +
          "." + (typeof el.className === "string" ? el.className.trim().split(/\\s+/)[0] : "") +
          " — \\"" + (el.textContent || "").trim().slice(0, 40) + "…\\"",
      );
    }
  }
  return [...new Set(out)];
})()
`;


/** Nothing is measured mid-animation: an arriving overlay is fractionally scaled. */
async function still(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => {
          const timing = animation.effect?.getComputedTiming();
          return timing !== undefined && Number.isFinite(timing.endTime ?? Infinity);
        })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

/** Audits one surface. The findings are printed and then required to be none. */
async function audit(page: Page, label: string): Promise<void> {
  await still(page);
  const findings = (await page.evaluate(AUDIT)) as string[];
  if (findings.length > 0) console.log(`\n──── ${label}\n   ${findings.join("\n   ")}`);
  expect(findings, label).toEqual([]);
}

/** Nothing already on screen may move because the pointer arrived. */
async function noShift(page: Page, label: string, act: () => Promise<void>): Promise<void> {
  const SNAP = `(() => {
    const out = {};
    const key = (el) => {
      const parts = [];
      for (let node = el; node && node !== document.body; node = node.parentElement) {
        const parent = node.parentElement;
        const nth = parent ? [...parent.children].indexOf(node) : 0;
        const cls = typeof node.className === "string" && node.className
          ? "." + node.className.trim().split(/\\s+/)[0]
          : "";
        parts.unshift(node.tagName.toLowerCase() + cls + ":" + nth);
      }
      return parts.join(">");
    };
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      out[key(el)] = [r.left, r.top].map((n) => Math.round(n * 100) / 100).join(",");
    }
    return out;
  })()`;
  await still(page);
  await page.waitForTimeout(400);
  const before = (await page.evaluate(SNAP)) as Record<string, string>;
  await act();
  await page.waitForTimeout(320);
  const after = (await page.evaluate(SNAP)) as Record<string, string>;
  const moved = Object.entries(before)
    .filter(([k, v]) => after[k] !== undefined && after[k] !== v)
    .map(([k, v]) => `${k}: ${v} -> ${after[k]}`);
  if (moved.length > 0) console.log(`\n──── shift on ${label}\n   ${moved.slice(0, 10).join("\n   ")}`);
  expect(moved, `shift on ${label}`).toEqual([]);
}

/** Reports text that is cut off with no way to read the rest of it. */
async function noSilentTruncation(page: Page, label: string): Promise<void> {
  await still(page);
  const findings = (await page.evaluate(TRUNCATION)) as string[];
  if (findings.length > 0) console.log(`\n──── ${label}\n   ${findings.join("\n   ")}`);
  expect(findings, label).toEqual([]);
}

/** Tabs through the surface and reports anything focus does not visibly mark. */
async function focusSweep(page: Page, label: string, steps = 22): Promise<void> {
  const missing: string[] = [];
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  for (let i = 0; i < steps; i += 1) {
    await page.keyboard.press("Tab");
    const result = (await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || el === document.body) return null;
      const s = getComputedStyle(el);
      const name =
        el.tagName.toLowerCase() +
        (typeof el.className === "string" && el.className
          ? "." + el.className.trim().split(/\s+/)[0]
          : "");
      // A caret counts, and so does a wash, a ring, a border, an outline — or a
      // mark drawn by a pseudo-element, which is how the outline's append zone and
      // the settings rail say it, and which reading the element's own style alone
      // reports as nothing at all.
      const pseudoMark = ["::before", "::after"].some((which) => {
        const p = getComputedStyle(el, which);
        if (p.content === "none") return false;
        return (
          Number(p.opacity) > 0.5 &&
          (p.backgroundColor !== "rgba(0, 0, 0, 0)" || p.borderTopWidth !== "0px")
        );
      });
      const marked =
        s.outlineStyle !== "none" ||
        s.boxShadow !== "none" ||
        el.tagName === "TEXTAREA" ||
        el.tagName === "INPUT" ||
        s.backgroundColor !== "rgba(0, 0, 0, 0)" ||
        s.borderTopWidth !== "0px" ||
        pseudoMark;
      return { name, marked, shadow: s.boxShadow.slice(0, 40) };
    })) as { name: string; marked: boolean; shadow: string } | null;
    if (result && !result.marked) missing.push(result.name);
  }
  const unmarked = [...new Set(missing)];
  if (unmarked.length > 0) console.log(`\n──── focus sweep ${label}\n   ${unmarked.join("\n   ")}`);
  expect(unmarked, `focus sweep ${label}`).toEqual([]);
}


// Measuring thirty-odd surfaces costs more wall clock than asserting one
// behaviour does, and under a loaded suite it costs more than the default budget.
// `slow` is the idiomatic way to say "this one is a sweep", rather than trimming
// the coverage until it fits.
test("every surface is measured and square", async ({ page }) => {
  test.slow();
  await page.goto("/");
  await audit(page, "graph picker (empty)");

  await createGraph(page, "QA Graph");
  await audit(page, "journal (empty)");

  await startOutline(page);
  await page.keyboard.type("Measure Loro merge throughput");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.keyboard.type("p95 latency on a 100k-block graph");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.type("Compare Notion, Logseq and Obsidian");
  await awaitSaved(page);
  await audit(page, "journal (outline)");
  await noSilentTruncation(page, "journal truncation");
  await focusSweep(page, "journal");

  // Nothing already on screen may move when a row is merely pointed at.
  await noShift(page, "hovering an outline row", async () => {
    await page.getByTestId("outline-row").first().hover();
  });
  await noShift(page, "hovering the rail", async () => {
    await page.getByTestId("sidebar").hover();
  });
  await noShift(page, "hovering a query-less page title", async () => {
    await page.getByTestId("journal-title").hover();
  });

  await openBlockMenu(page);
  await audit(page, "block context menu");
  await page.keyboard.press("Escape");

  await openBlockProperties(page);
  await audit(page, "property picker");
  await page.keyboard.press("Escape");

  await openBlockTags(page);
  await audit(page, "tag picker");
  await page.keyboard.press("Escape");

  // A task's marks hang before the writing and must not push it.
  await openBlockProperties(page);
  await page.getByTestId("property-picker").getByRole("option", { name: "Status", exact: true }).click();
  await page.getByTestId("property-picker").getByRole("option", { name: "Doing", exact: true }).click();
  await awaitSaved(page);
  await openBlockProperties(page);
  await page.getByTestId("property-picker").getByRole("option", { name: "Priority", exact: true }).click();
  await page.getByTestId("property-picker").getByRole("option", { name: "High", exact: true }).click();
  await awaitSaved(page);
  await audit(page, "task row (status + priority)");

  // The slash menu, then a query block: the densest control surface there is.
  const line = page.getByLabel("Block text").last();
  await line.click();
  await line.press("End");
  await line.press("Enter");
  await page.keyboard.type("/query");
  await audit(page, "slash menu");
  await page.getByTestId("slash-menu").getByRole("option", { name: /^Query/ }).click();
  await expect(page.getByTestId("query-builder")).toBeVisible();
  await awaitSaved(page);
  await audit(page, "query block (builder + table)");

  await page.getByTestId("qb-add-condition").click();
  await audit(page, "query builder with a condition");

  await noShift(page, "hovering a result row", async () => {
    await page.getByTestId("query-table").locator("tbody tr").first().hover();
  });

  await chooseFromMenu(page, page.getByTestId("query-view-trigger"), "List");
  await expect(page.getByTestId("query-list")).toBeVisible();
  await audit(page, "query block (list)");

  await page.getByTestId("open-palette").click();
  await audit(page, "command palette");
  await page.getByTestId("command-input").fill("jour");
  await audit(page, "command palette (filtered)");
  await page.keyboard.press("Escape");

  await page.keyboard.press("ControlOrMeta+/");
  await audit(page, "shortcut sheet");
  await page.keyboard.press("Escape");

  await openSettings(page, "appearance");
  await audit(page, "settings / appearance");
  for (const section of ["language", "journal", "tasks", "keyboard", "storage", "graph", "danger"]) {
    await page.getByTestId(`settings-tab-${section}`).click();
    await audit(page, `settings / ${section}`);
  }
  await page.keyboard.press("Escape");

  await page.getByTestId("nav-tags").click();
  await audit(page, "tags (empty)");
  await page.getByTestId("new-tag").click();
  await page.keyboard.type("design-system");
  await page.keyboard.press("Enter");
  await page.keyboard.type("a second tag with a name long enough to need its column");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Escape");
  await awaitSaved(page);
  await audit(page, "tags (a flat list)");

  // The manager at its densest: a heading, rows of three controls each, and the
  // panel of swatches and marks that one of those controls opens.
  await page.getByTestId("tag-mark").first().click();
  const identity = page.getByTestId("tag-identity");
  await expect(identity).toBeVisible();
  await audit(page, "tag identity panel");
  await identity.getByTestId("tag-group-field").fill("Areas");
  await identity.getByTestId("tag-group-field").press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("tag-group-name")).toHaveText(["Areas", "Ungrouped"]);
  await awaitSaved(page);
  await audit(page, "tags (grouped)");
  await noSilentTruncation(page, "tags directory truncation");

  // A tag has a page of its own, and it is the one surface whose whole body is a
  // query: a tab strip of saved views over a caption and a result.
  await page.getByTestId("tag-row-link").first().click();
  await expect(page.getByTestId("tag-title")).toHaveValue("design-system");
  await audit(page, "tag page");
  await page.getByTestId("tag-add-default").click();
  await page.getByTestId("property-picker").getByRole("option", { name: "Status", exact: true }).click();
  await page.getByTestId("property-picker").getByRole("option", { name: "Doing", exact: true }).click();
  await awaitSaved(page);
  await audit(page, "tag page (a default)");
  await page.getByTestId("query-view-add").click();
  await audit(page, "tag page (new view)");
  await page.keyboard.press("Escape");

  await createPage(page, "A regular page with a fairly long title that has to wrap or truncate");
  await audit(page, "page (long title)");
  await noSilentTruncation(page, "long-content truncation");
  await openPageProperties(page);
  await audit(page, "page properties picker");
  await page.keyboard.press("Escape");

  // A toast is the one surface the reader did not ask for. It needs a block to
  // be rejected on, and the page just created has none.
  await startOutline(page);
  await page.keyboard.type("a block to be refused an indent");
  await awaitSaved(page);
  await page.getByLabel("Block text").first().click();
  await page.keyboard.press("Tab"); // rejected by the core: first sibling
  await expect(page.getByTestId("toast")).toBeVisible();
  await audit(page, "toast");

  // A rail with no rail: the collapsed shell and the topbar's own controls.
  await page.keyboard.press("ControlOrMeta+\\");
  await audit(page, "rail collapsed");
});

test("every surface is measured and square on a phone", async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await audit(page, "390px graph picker");
  await createGraph(page, "Narrow");
  await audit(page, "390px journal");
  await startOutline(page);
  await page.keyboard.type("A block on a narrow screen");
  await awaitSaved(page);
  await audit(page, "390px outline");
  await openSidebar(page);
  await audit(page, "390px drawer");
  // Settings is reached from inside the drawer, which is where its one permanent
  // route lives at this width; closing it first would only have to reopen it.
  await page.getByTestId("open-settings").click();
  await expect(page.getByTestId("settings-dialog")).toBeVisible();
  await audit(page, "390px settings");
  await page.getByTestId("settings-tab-keyboard").click();
  await audit(page, "390px settings / keyboard");
  await page.keyboard.press("Escape");
  await page.getByTestId("outline-row").first().hover();
  await audit(page, "390px outline (pointer)");
});

// A dialog that resizes as the reader moves down its own nav makes them chase the
// row they were travelling toward. This is the one surface in the product with a
// list of sections and a body that differs in length per section, so it is the
// one that has to be measured.
test("the settings dialog is one size, whatever section is open", async ({ page }) => {
  await createGraph(page, "Settings Size Graph");
  await openSettings(page, "appearance");
  const shell = page.getByTestId("settings-dialog");
  await expect(shell).toBeVisible();

  const sizeOf = async () => {
    // The dialog arrives from 0.985 scale, and a scaled box measures scaled.
    await still(page);
    return shell.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { height: box.height, width: box.width };
    });
  };

  const first = await sizeOf();
  // Whole, because this box draws its own edge and the seam inside it.
  expect(first.height % 1).toBe(0);
  // Sized for the *nav*, not for the longest pane. Sized for the pane it was five
  // hundred pixels tall and most sections ended a third of the way down; the
  // section list is the one thing here that may not scroll, so it is what the
  // height answers to.
  const nav = await page.locator(".settings-nav").evaluate((node) => ({
    scroll: node.scrollHeight,
    client: node.clientHeight,
  }));
  expect(nav.scroll).toBeLessThanOrEqual(nav.client + 1);
  expect(first.height).toBeLessThan(440);

  for (const section of ["language", "tasks", "keyboard", "storage", "graph"]) {
    await page.getByTestId(`settings-tab-${section}`).click();
    const next = await sizeOf();
    expect(next.height, section).toBe(first.height);
    expect(next.width, section).toBe(first.width);
  }
});

// The palette is one size whatever is typed into it. It was a `max-height`, so
// the panel grew and shrank on every keystroke: the row a pointer was travelling
// toward was somewhere else on arrival, and the foot that states the three keys
// it answers to walked up and down the screen while the reader read it.
test("the command palette holds its size as the list narrows", async ({ page }) => {
  await createGraph(page, "Palette Graph");
  await createPage(page, "Something to find");
  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.locator(".cmdk");
  await expect(palette).toBeVisible();
  // Measured after the arrival, or the first reading catches the entrance
  // translate and every comparison is three pixels of animation.
  await palette.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)));
  const full = (await palette.boundingBox())!;
  expect(await palette.locator(".cmdk-row").count()).toBeGreaterThan(6);

  await page.keyboard.type("zzzz");
  await expect(palette.locator(".cmdk-row")).toHaveCount(1);
  const narrowed = (await palette.boundingBox())!;
  expect(narrowed.height).toBe(full.height);
  expect(narrowed.y).toBe(full.y);
  await audit(page, "command palette (one match)");
});

// A panel opens toward the middle of the window, not toward the nearest edge.
// Every summoned surface used to be pinned by its left edge and then shoved back
// inside the viewport, so a control at the right of the measure — a tag at the end
// of a line, the sort button at the end of a query header — opened outwards and
// then slid, landing aligned with neither edge of the thing it belonged to.
test("a summoned panel opens toward the middle of the window", async ({ page }) => {
  await createGraph(page, "Placement Graph");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Tags" }).click();
  await page.getByTestId("new-tag").click();
  await page.getByTestId("new-tag-name").fill("Placement");
  await page.getByTestId("new-tag-name").press("Enter");
  await openSidebar(page);
  await page.getByTestId("sidebar").getByRole("link", { name: "Journal" }).click();
  await startOutline(page);
  await typeInFocusedBlock(page, "a line with a tag at its end");

  // A query header's sort button sits at the far right of the measure, and it is
  // point-like: narrower than the panel it opens. So the panel grows left and
  // their right edges meet.
  const line = page.getByLabel("Block text").first();
  await line.click();
  await line.press("End");
  await line.press("Enter");
  await page.keyboard.type("/query");
  await page.getByTestId("slash-menu").getByRole("option", { name: /^Query/ }).click();
  const query = page.getByTestId("query-block");
  await expect(query.getByTestId("query-table")).toBeVisible();
  const trigger = query.getByTestId("query-sort-trigger");
  const triggerBox = (await trigger.boundingBox())!;
  const width = page.viewportSize()!.width;
  expect(triggerBox.x + triggerBox.width / 2).toBeGreaterThan(width / 2);
  await trigger.click();
  const panel = page.getByTestId("query-sort-panel");
  await expect(panel).toBeVisible();
  const panelBox = (await panel.boundingBox())!;
  expect(Math.abs((panelBox.x + panelBox.width) - (triggerBox.x + triggerBox.width)))
    .toBeLessThan(2);
  expect(panelBox.x).toBeLessThan(triggerBox.x);
  await page.keyboard.press("Escape");

  // A field is the exception: the panel stands in for it, so it keeps its left
  // edge however far right the field sits.
  await line.click();
  await line.press("End");
  await page.keyboard.type(" #Pl");
  const menu = page.getByTestId("tag-menu");
  await expect(menu).toBeVisible();
  const [lineBox, menuBox] = [(await line.boundingBox())!, (await menu.boundingBox())!];
  expect(Math.abs(menuBox.x - lineBox.x)).toBeLessThan(2);
});

// The date editor is taller than the middling strip of room below this line.
// Shrinking it until it technically fits makes its rows look crushed and hides
// the fact that the whole editor fits above. Placement answers the rendered box,
// so the available side wins before any height constraint is applied.
test("the scheduled editor flips above before it has to shrink", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 633 });
  await createGraph(page, "Scheduled Placement Graph");
  await startOutline(page);
  for (let index = 0; index < 32; index += 1) await page.keyboard.press("Enter");

  const scroller = page.locator(".page-scroll");
  await scroller.evaluate((node) => {
    const anchor = document.activeElement;
    if (!(anchor instanceof HTMLElement)) throw new Error("the last block lost focus");
    node.scrollTop += anchor.getBoundingClientRect().top - 430;
  });
  const line = page.locator('textarea:focus');
  await expect.poll(async () => (await line.boundingBox())?.y).toBeCloseTo(430, 0);
  const lineBox = (await line.boundingBox())!;
  const roomBelow = 633 - lineBox.y - lineBox.height - 4 - 12;

  await page.keyboard.type("/scheduled");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await page.keyboard.press("Enter");

  const picker = page.getByTestId("property-picker");
  await expect(picker).toBeVisible();
  await expect(picker).toHaveAttribute("data-side", "top");
  const pickerBox = (await picker.boundingBox())!;
  expect(pickerBox.height).toBeGreaterThan(roomBelow);
  expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(lineBox.y - 3);
  expect(Math.abs(pickerBox.x - lineBox.x)).toBeLessThan(2);
});

test("the property editor remains an edge-to-edge sheet on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await createGraph(page, "Compact Property Sheet Graph");
  await startOutline(page);
  await page.keyboard.type("/scheduled");
  await expect(page.getByTestId("slash-menu")).toBeVisible();
  await page.keyboard.press("Enter");

  const picker = page.getByTestId("property-picker");
  await expect(picker).toBeVisible();
  const box = (await picker.boundingBox())!;
  expect(box.x).toBe(0);
  expect(box.width).toBe(390);
  expect(box.y + box.height).toBe(844);
});
