// Find in the open diff. Matching ignores case.

// A few characters change length when lowercased (İ), which would shift match positions;
// such a line matches with its case kept.
const fold = (s) => {
  const lower = s.toLowerCase();
  return lower.length === s.length ? lower : s;
};

/** Indexes of the rows whose text holds `query`. */
export function findRows(rows, query) {
  if (!query) return [];
  const q = fold(query), out = [];
  rows.forEach((row, i) => { if (fold(row.text).includes(q)) out.push(i); });
  return out;
}

/** The first match after `from` going `dir` (1 or -1), wrapping around; -1 when nothing matches. */
export function nextMatch(matches, from, dir) {
  if (!matches.length) return -1;
  if (dir > 0) return matches.find((i) => i > from) ?? matches[0];
  return [...matches].reverse().find((i) => i < from) ?? matches[matches.length - 1];
}

/**
 * Rows holding `query` across several files' diffs, in file order; each hit carries its file's
 * rows. Stops after `limit` hits and says whether more were left.
 * @template T @param {{ entry: T, rows: { kind: string, text: string }[] }[]} files
 */
export function searchFiles(files, query, limit) {
  const hits = [];
  if (!query) return { hits, more: false };
  for (const { entry, rows } of files) {
    for (const row of findRows(rows, query)) {
      if (rows[row].kind === "hunk") continue;
      if (hits.length === limit) return { hits, more: true };
      hits.push({ entry, rows, row });
    }
  }
  return { hits, more: false };
}

/** A row's colored runs, cut where `query` starts and ends; the matched pieces carry `match: true`. */
export function markRuns(runs, query) {
  const text = runs.map((r) => r.text).join(""), q = fold(query ?? ""), lower = fold(text);
  const hits = [];
  if (q) for (let at = lower.indexOf(q); at >= 0; at = lower.indexOf(q, at + q.length)) hits.push([at, at + q.length]);
  if (!hits.length) return runs;
  const out = [];
  let pos = 0, h = 0;
  for (const run of runs) {
    const end = pos + run.text.length;
    for (let start = pos; start < end;) {
      while (h < hits.length && hits[h][1] <= start) h++;
      const hit = hits[h], inside = Boolean(hit) && hit[0] <= start;
      const stop = Math.min(end, !hit ? end : inside ? hit[1] : hit[0]);
      out.push({ ...run, text: text.slice(start, stop), match: inside });
      start = stop;
    }
    pos = end;
  }
  return out;
}
