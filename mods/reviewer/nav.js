// Cursor movement over diff rows and the file list.

const clamp = (i, max) => Math.max(0, Math.min(i, max));

const isChange = (row) => row.kind === "add" || row.kind === "del";

const isBlockStart = (rows, k) => isChange(rows[k]) && (k === 0 || !isChange(rows[k - 1]));

export function moveLine(rows, i, delta) {
  return rows.length === 0 ? 0 : clamp(i + delta, rows.length - 1);
}

// Going back from inside a block lands on that block's start first,
// because its start is the nearest block start before the cursor.
export function nextChange(rows, i, dir) {
  for (let k = i + dir; k >= 0 && k < rows.length; k += dir) {
    if (isBlockStart(rows, k)) return k;
  }
  return i;
}

export function nextFile(files, current, dir) {
  return files.length === 0 ? -1 : clamp(current + dir, files.length - 1);
}

export function selectionRange(anchor, cursor) {
  return { from: Math.min(anchor, cursor), to: Math.max(anchor, cursor) };
}
