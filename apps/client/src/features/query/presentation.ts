// Which answers the reader has folded.
//
// Query disclosure is a reader preference, not graph data: folding an answer says
// "not now, and not for me", which is nothing a collaborator should inherit and
// nothing an archive should carry. So it lives in this browser, beside the theme
// and the rail's width — but it does *live* there. Keeping it in memory meant an
// answer folded before lunch was open again after a reload, which is the one
// place a preference is least believable: the reader has to fold it a second time
// to make the same point.
//
// Only the folded keys are stored, because open is what a query is: a graph
// nobody has folded anything in writes nothing at all. They are kept per graph,
// since an execution key names a block or a tag inside one, and named by the
// graph's id rather than by the session that opened it — a session is one visit,
// and the fold outliving the visit is the whole point.
//
// The store is read on every question and written on every fold, with nothing
// cached in between. A panel asks once as it mounts, so the cost is a parse of a
// short list per query on screen; what it buys is that two windows of the same
// graph cannot lose each other's folds to a snapshot one of them took first.
//
// It is bounded. A block that is deleted takes its key out of the graph but not
// out of this list, and nothing would ever come back to clear it, so the oldest
// fold is dropped at the ceiling rather than letting one browser accumulate a
// list nobody is reading.

const STORAGE_KEY = "neoseq.query-disclosure.v1";

/**
 * How many folds one graph may remember. A reader folds a handful of answers;
 * this is the ceiling that keeps dead keys from growing without an owner, not a
 * budget anybody should reach.
 */
const LIMIT = 256;

type Folded = Record<string, string[]>;

function read(): Folded {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object") return {};
    const folded: Folded = {};
    for (const [graphId, keys] of Object.entries(value as Record<string, unknown>)) {
      if (Array.isArray(keys)) {
        folded[graphId] = keys.filter((key): key is string => typeof key === "string");
      }
    }
    return folded;
  } catch {
    // Private mode, a disabled store, or a corrupt blob: every answer opens,
    // which is the state a graph starts in anyway.
    return {};
  }
}

function write(folded: Folded): void {
  try {
    if (Object.keys(folded).length === 0) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(folded));
  } catch {
    // A blocked write costs the next launch, not this session.
  }
}

export function queryResultsAreOpen(graphId: string, owner: string): boolean {
  return !read()[graphId]?.includes(owner);
}

export function rememberQueryResultsOpen(
  graphId: string,
  owner: string,
  open: boolean,
): void {
  const folded = read();
  const kept = (folded[graphId] ?? []).filter((key) => key !== owner);
  // The newest fold goes last, so the one dropped at the ceiling is the one the
  // reader touched longest ago.
  const next = open ? kept : [...kept, owner].slice(-LIMIT);
  if (next.length === 0) delete folded[graphId];
  else folded[graphId] = next;
  write(folded);
}

/**
 * Test seam: forgets every fold. Disclosure is browser-wide, so one test folding
 * an answer would otherwise reach the next one.
 */
export function resetQueryDisclosure(): void {
  write({});
}
