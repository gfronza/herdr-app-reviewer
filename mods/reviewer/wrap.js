// Wrapping a diff line. The diff font is monospaced, so a line breaks at a column rather than at
// a measured width; like the rest of the diff's width math, a column is one UTF-16 unit.

/** How many screen lines a line of `length` characters takes at `cols` columns. */
export const wrappedLines = (length, cols) => Math.max(1, Math.ceil(length / Math.max(1, cols)));

/**
 * Cuts a row's runs into screen lines of at most `cols` characters. Each piece keeps its run's
 * other fields (scope, match), so colors and find marks carry across a break.
 * @template {{ text: string }} R
 * @param {R[]} runs
 * @param {number} cols
 * @returns {R[][]}
 */
export function wrapRuns(runs, cols) {
  const width = Math.max(1, cols), lines = [[]];
  let room = width;
  for (const run of runs) {
    for (let at = 0; at < run.text.length;) {
      if (room === 0) { lines.push([]); room = width; }
      const piece = run.text.slice(at, at + room);
      lines[lines.length - 1].push({ ...run, text: piece });
      at += piece.length; room -= piece.length;
    }
  }
  return lines;
}
