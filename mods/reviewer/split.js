// Old and new side by side: each screen line holds a diff row index per side, or null for a blank.

/**
 * A hunk header spans both sides; a context row shows on both; in a run of changes, removed
 * lines go left and added lines right, paired in order.
 * @param {{ kind: string }[]} rows
 * @returns {{ left: number | null, right: number | null }[]}
 */
export function splitLines(rows) {
  const lines = [];
  let dels = [], adds = [];
  const flush = () => {
    for (let k = 0; k < Math.max(dels.length, adds.length); k++) lines.push({ left: dels[k] ?? null, right: adds[k] ?? null });
    dels = []; adds = [];
  };
  rows.forEach((row, i) => {
    if (row.kind === "del") dels.push(i);
    else if (row.kind === "add") adds.push(i);
    else { flush(); lines.push({ left: i, right: i }); }
  });
  flush();
  return lines;
}

/** Row indexes as the fewest spans that hold only those rows, for coloring what is on screen. */
export function spans(rows) {
  const out = [];
  for (const i of [...new Set(rows)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last.end === i) last.end = i + 1;
    else out.push({ start: i, end: i + 1 });
  }
  return out;
}

const within = (i, start, end) => i !== null && start <= i && i <= end;

/** The last screen line holding any of the rows from `start` to `end`, or -1. */
export function lastLine(lines, start, end) {
  for (let k = lines.length - 1; k >= 0; k--) if (within(lines[k].left, start, end) || within(lines[k].right, start, end)) return k;
  return -1;
}
