// Comments on diff lines, and the plain-text review built from them.

/**
 * at: the anchored row's base-side (HEAD) line; an added row takes the base line it precedes.
 * Edits to the working tree shift new-side numbers but leave the base side fixed.
 * @typedef {{ key: string, mark: string, text: string, at: number }} Anchor
 * @typedef {{ id: string, root: string, path: string, anchors: Anchor[], text: string }} Comment
 */

const MARKS = { add: "+", del: "-", ctx: " " };

const keyOf = (row) => (row.kind === "del" ? `o:${row.old}` : `n:${row.new}`);

const lineOf = (key) => Number(key.slice(2));

const sideOf = (key) => (key[0] === "o" ? "old" : "new");

const matches = (row, anchor) => MARKS[row.kind] === anchor.mark && row.text === anchor.text;

/** @returns {Comment} */
export function createComment({ id, root, path, rows, from, to, text }) {
  const at = basePositions(rows);
  const anchors = [];
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    const row = rows[i];
    if (row.kind !== "hunk") anchors.push({ key: keyOf(row), mark: MARKS[row.kind], text: row.text, at: at[i] });
  }
  if (anchors.length === 0) throw new Error("A comment needs at least one diff line.");
  return { id, root, path, anchors, text };
}

function basePositions(rows) {
  let next = 1;
  return rows.map((row) => {
    if (row.kind === "hunk") {
      next = hunkBaseStart(row.text);
      return null;
    }
    if (row.kind === "add") return next;
    next = row.old + 1;
    return row.old;
  });
}

// "@@ -a,0 ..." inserts after base line a; otherwise a is the hunk's first base line.
function hunkBaseStart(header) {
  const [, start, count] = /^@@ -(\d+)(?:,(\d+))?/.exec(header);
  return count === "0" ? Number(start) + 1 : Number(start);
}

/** @returns {{ start: number, end: number, stale: boolean }} */
export function locate(comment, rows) {
  const at = basePositions(rows);
  const found = comment.anchors.map((anchor) => findAnchor(anchor, rows, at));
  const start = found[0] >= 0 ? found[0] : firstAtOrAfter(comment.anchors[0], rows, at);
  if (start < 0) return { start: -1, end: -1, stale: true };
  const last = found[found.length - 1];
  const end = last >= start ? last : Math.max(start, ...found);
  return { start, end, stale: found.some((i) => i < 0) };
}

// Added rows come before the base line they share a position with.
const order = (at, mark) => 2 * at + (mark === "+" ? 0 : 1);

function firstAtOrAfter(anchor, rows, at) {
  const target = order(anchor.at, anchor.mark);
  return rows.findIndex((row, i) => at[i] != null && order(at[i], MARKS[row.kind]) >= target);
}

// Several added rows can share one base position, so repeats go to the nearest new-side number.
function findAnchor(anchor, rows, at) {
  let best = -1;
  rows.forEach((row, i) => {
    if (at[i] !== anchor.at || !matches(row, anchor)) return;
    if (best < 0 || gap(row, anchor) < gap(rows[best], anchor)) best = i;
  });
  return best;
}

const gap = (row, anchor) => Math.abs(row.new - lineOf(anchor.key));

/** @param {Comment[]} comments */
export function formatReview(comments, staleIds = new Set()) {
  const sorted = [...comments].sort(
    (a, b) => compare(a.root, b.root) || compare(a.path, b.path) || span(a).from - span(b).from,
  );
  const out = ["Code review comments"];
  let root = null;
  for (const comment of sorted) {
    if (comment.root !== root) {
      root = comment.root;
      out.push("", root);
    }
    out.push("", locationLine(comment, staleIds.has(comment.id)));
    for (const anchor of comment.anchors) out.push(`    ${anchor.mark} ${anchor.text}`);
    out.push(comment.text);
  }
  return out.join("\n");
}

const compare = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// New-side numbers locate a comment, unless it covers only removed lines.
function span(comment) {
  const newLines = comment.anchors.filter((a) => sideOf(a.key) === "new").map((a) => lineOf(a.key));
  const removed = newLines.length === 0;
  const lines = removed ? comment.anchors.map((a) => lineOf(a.key)) : newLines;
  return { from: Math.min(...lines), to: Math.max(...lines), removed };
}

function locationLine(comment, stale) {
  const { from, to, removed } = span(comment);
  const range = from === to ? `${from}` : `${from}-${to}`;
  return `${comment.path}:${range}${removed ? " (removed)" : ""}${stale ? " (lines changed since this comment)" : ""}`;
}
