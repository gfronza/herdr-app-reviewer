// The diff as one list of rows: one file's, or every listed file's one after another. Each file is
// a part holding its own rows; `offset` is where its first row sits in the list, and `start` is
// where the part begins, which is its heading row when files are headed.

/**
 * @template {{ rows: { kind: string }[] }} F
 * @param {F[]} files
 * @param {boolean} headed Puts a row of kind "file" above each file's rows.
 */
export function joinDiffs(files, headed) {
  /** @type {{ kind: string, old?: number | null, new?: number | null, text?: string }[]} */
  const rows = [];
  const parts = [];
  for (const file of files) {
    const start = rows.length;
    if (headed) rows.push({ kind: "file", old: null, new: null, text: "" });
    parts.push({ ...file, start, offset: rows.length });
    for (const row of file.rows) rows.push(row);
  }
  return { rows, parts };
}

/** The part that row `i` belongs to; a heading belongs to the file below it. */
export function partAt(parts, i) {
  for (let k = parts.length - 1; k >= 0; k--) if (parts[k].start <= i) return parts[k];
  return parts[0] ?? null;
}

/**
 * Where the cursor goes when the diff is read again: the same row of the same file, kept inside
 * that file, or the same place in the list when the file is gone from it.
 * @param {{ parts: { key: string, start: number, offset: number }[] } | null} before
 * @param {number} cursor
 * @param {{ rows: unknown[], parts: { key: string, offset: number, rows: unknown[] }[] }} after
 */
export function keepCursor(before, cursor, after) {
  const was = before && partAt(before.parts, cursor);
  const now = was && after.parts.find((p) => p.key === was.key);
  const at = now ? now.offset + cursor - was.offset : cursor;
  const last = now ? now.offset + now.rows.length - 1 : after.rows.length - 1;
  return Math.max(0, Math.min(at, last));
}
