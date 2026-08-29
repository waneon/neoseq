// What the reader has folded, and what they have opened.
//
// Query disclosure is a reader preference, not graph data: folding an answer says
// "not now, and not for me", which is nothing a collaborator should inherit and
// nothing an archive should carry. The same is true of the editor above it —
// opening the question is how one reader works on it, not something the question
// is. So both live in this browser, beside the theme and the rail's width — but
// they do *live* there. Keeping either in memory meant an answer folded before
// lunch was open again after a reload, and an editor left open came back shut,
// which is the one place a preference is least believable: the reader has to
// make the same point a second time.
//
// **Two lists, each naming the exceptions.** An answer is what a query *is*, so
// only the folded ones are written down; the editor is chrome over a sentence
// that already reads, so only the opened ones are. Either way a graph nobody has
// touched stores nothing at all, and a list is the reader's departures from the
// surface's own default rather than a census of every query they have met.
//
// They are kept per graph, since an execution key names a block or a tag inside
// one, and named by the graph's id rather than by the session that opened it —
// a session is one visit, and the preference outliving the visit is the whole
// point.
//
// A list is read on every question and written on every change, with nothing
// cached in between. A panel asks once as it mounts, so the cost is a parse of a
// short list per query on screen; what it buys is that two windows of the same
// graph cannot lose each other's answers to a snapshot one of them took first.
//
// They are bounded. A block that is deleted takes its key out of the graph but
// not out of these lists, and nothing would ever come back to clear it, so the
// oldest entry is dropped at the ceiling rather than letting one browser
// accumulate a list nobody is reading.

const FOLDED_RESULTS_KEY = "neoseq.query-disclosure.v1";
const OPEN_EDITORS_KEY = "neoseq.query-editor.v1";

/**
 * How many keys one graph may remember in one list. A reader folds a handful of
 * answers and opens a handful of editors; this is the ceiling that keeps dead
 * keys from growing without an owner, not a budget anybody should reach.
 */
const LIMIT = 256;

type Members = Record<string, string[]>;

/**
 * One per-graph list of execution keys, kept in this browser. Membership is the
 * whole state: what it means to be in the list is the caller's to name.
 */
function keySet(storageKey: string) {
  const read = (): Members => {
    try {
      const raw = localStorage.getItem(storageKey);
      const value: unknown = raw ? JSON.parse(raw) : null;
      if (!value || typeof value !== "object") return {};
      const members: Members = {};
      for (const [graphId, keys] of Object.entries(value as Record<string, unknown>)) {
        if (Array.isArray(keys)) {
          members[graphId] = keys.filter((key): key is string => typeof key === "string");
        }
      }
      return members;
    } catch {
      // Private mode, a disabled store, or a corrupt blob: every list is empty,
      // which is the state a graph starts in anyway.
      return {};
    }
  };

  const write = (members: Members): void => {
    try {
      if (Object.keys(members).length === 0) localStorage.removeItem(storageKey);
      else localStorage.setItem(storageKey, JSON.stringify(members));
    } catch {
      // A blocked write costs the next launch, not this session.
    }
  };

  return {
    has(graphId: string, key: string): boolean {
      return read()[graphId]?.includes(key) ?? false;
    },
    set(graphId: string, key: string, member: boolean): void {
      const members = read();
      const kept = (members[graphId] ?? []).filter((entry) => entry !== key);
      // The newest goes last, so the one dropped at the ceiling is the one the
      // reader touched longest ago.
      const next = member ? [...kept, key].slice(-LIMIT) : kept;
      if (next.length === 0) delete members[graphId];
      else members[graphId] = next;
      write(members);
    },
    clear(): void {
      write({});
    },
  };
}

const foldedResults = keySet(FOLDED_RESULTS_KEY);
const openEditors = keySet(OPEN_EDITORS_KEY);

export function queryResultsAreOpen(graphId: string, owner: string): boolean {
  return !foldedResults.has(graphId, owner);
}

export function rememberQueryResultsOpen(graphId: string, owner: string, open: boolean): void {
  foldedResults.set(graphId, owner, !open);
}

/**
 * Whether the question is open over its answer. `whenUnasked` is what the
 * surface would have decided on its own for a reader who has never pressed the
 * caption — a query with no conditions has nothing to say in one, so the builder
 * is its only honest first screen, and that stays true however often it is met.
 */
export function queryEditorIsOpen(graphId: string, owner: string, whenUnasked: boolean): boolean {
  return openEditors.has(graphId, owner) || whenUnasked;
}

export function rememberQueryEditorOpen(graphId: string, owner: string, open: boolean): void {
  openEditors.set(graphId, owner, open);
}

/**
 * Test seam: forgets every fold and every open editor. Disclosure is
 * browser-wide, so one test folding an answer would otherwise reach the next.
 */
export function resetQueryDisclosure(): void {
  foldedResults.clear();
  openEditors.clear();
}
