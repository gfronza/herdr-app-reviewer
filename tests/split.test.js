import { test } from "node:test";
import assert from "node:assert/strict";
import { lastLine, spans, splitLines } from "../mods/reviewer/split.js";

const rows = (...kinds) => kinds.map((kind) => ({ kind }));
const pairs = (lines) => lines.map(({ left, right }) => [left, right]);

test("split: context and hunk rows sit on both sides", () => {
  assert.deepEqual(pairs(splitLines(rows("hunk", "ctx", "ctx"))), [[0, 0], [1, 1], [2, 2]]);
});

test("split: a changed line pairs its removed line with its added line", () => {
  assert.deepEqual(pairs(splitLines(rows("ctx", "del", "add", "ctx"))), [[0, 0], [1, 2], [3, 3]]);
});

test("split: more removed than added lines leaves blanks on the right", () => {
  assert.deepEqual(pairs(splitLines(rows("del", "del", "del", "add", "ctx"))), [[0, 3], [1, null], [2, null], [4, 4]]);
});

test("split: more added than removed lines leaves blanks on the left", () => {
  assert.deepEqual(pairs(splitLines(rows("hunk", "del", "add", "add"))), [[0, 0], [1, 2], [null, 3]]);
});

test("split: an added-only file is blank on the left", () => {
  assert.deepEqual(pairs(splitLines(rows("hunk", "add", "add"))), [[0, 0], [null, 1], [null, 2]]);
});

test("split: a hunk header ends a run of changes", () => {
  assert.deepEqual(pairs(splitLines(rows("del", "hunk", "add"))), [[0, null], [1, 1], [null, 2]]);
});

test("split: every diff row shows exactly once", () => {
  const kinds = rows("hunk", "ctx", "del", "del", "add", "ctx", "add", "hunk", "del", "ctx");
  const shown = splitLines(kinds).flatMap(({ left, right }) => (left === right ? [left] : [left, right])).filter((i) => i !== null);
  assert.deepEqual(shown.sort((a, b) => a - b), kinds.map((_, i) => i));
});

test("split: no rows gives no lines", () => {
  assert.deepEqual(splitLines([]), []);
});

test("lastLine: a block with more removed than added lines ends at its last removed line", () => {
  // 0 hunk, 1-3 del, 4 add, 5 ctx: lines 0|0, 1|4, 2|-, 3|-, 5|5.
  const lines = splitLines(rows("hunk", "del", "del", "del", "add", "ctx"));
  assert.equal(lastLine(lines, 1, 4), 3);
});

test("lastLine: one row finds its own line, and rows not shown find none", () => {
  const lines = splitLines(rows("ctx", "del", "add"));
  assert.equal(lastLine(lines, 2, 2), 1);
  assert.equal(lastLine(lines, 7, 9), -1);
});

test("spans: runs of row indexes, leaving out rows between them", () => {
  assert.deepEqual(spans([704, 0, 1, 2, 3, 705, 706]), [{ start: 0, end: 4 }, { start: 704, end: 707 }]);
});

test("spans: repeated indexes count once, and none gives none", () => {
  assert.deepEqual(spans([5, 5, 6]), [{ start: 5, end: 7 }]);
  assert.deepEqual(spans([]), []);
});
