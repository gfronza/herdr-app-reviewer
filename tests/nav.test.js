import { test } from "node:test";
import assert from "node:assert/strict";
import { moveLine, nextChange, nextFile, selectionRange } from "../mods/reviewer/nav.js";

const row = (kind) => ({ kind, old: null, new: null, text: "" });

// 0 hunk, 1 ctx, 2 del, 3 add, 4 ctx, 5 hunk, 6 add, 7 ctx, 8 del
const rows = ["hunk", "ctx", "del", "add", "ctx", "hunk", "add", "ctx", "del"].map(row);

test("moveLine clamps to the rows", () => {
  assert.equal(moveLine(rows, 4, 1), 5);
  assert.equal(moveLine(rows, 8, 1), 8);
  assert.equal(moveLine(rows, 0, -1), 0);
  assert.equal(moveLine(rows, 2, 100), 8);
  assert.equal(moveLine([], 0, 1), 0);
});

test("nextChange moves forward to the start of each block", () => {
  assert.equal(nextChange(rows, 0, 1), 2);
  assert.equal(nextChange(rows, 2, 1), 6);
  assert.equal(nextChange(rows, 3, 1), 6);
  assert.equal(nextChange(rows, 6, 1), 8);
});

test("nextChange stays put past the last block", () => {
  assert.equal(nextChange(rows, 8, 1), 8);
});

test("nextChange back goes to the current block's start, then the previous block", () => {
  assert.equal(nextChange(rows, 3, -1), 2);
  assert.equal(nextChange(rows, 2, -1), 2);
  assert.equal(nextChange(rows, 7, -1), 6);
  assert.equal(nextChange(rows, 6, -1), 2);
});

test("nextChange back stays put before the first block", () => {
  assert.equal(nextChange(rows, 1, -1), 1);
  assert.equal(nextChange([], 0, -1), 0);
});

test("nextFile steps to the neighbour and stays put at both ends", () => {
  const shown = [true, true, true];
  assert.equal(nextFile(shown, 0, 1), 1);
  assert.equal(nextFile(shown, 2, 1), 2);
  assert.equal(nextFile(shown, 1, -1), 0);
  assert.equal(nextFile(shown, 0, -1), 0);
});

test("nextFile skips hidden files", () => {
  assert.equal(nextFile([true, false, false, true], 0, 1), 3);
  assert.equal(nextFile([true, false, false, true], 3, -1), 0);
});

test("nextFile from a hidden file goes on from where it sits", () => {
  // l.js, src/s1.js and src/s2.js under a closed src/, z.js; s2.js was selected.
  const shown = [true, false, false, true];
  assert.equal(nextFile(shown, 2, 1), 3);
  assert.equal(nextFile(shown, 2, -1), 0);
});

test("nextFile from a hidden file with nothing shown that way stays put", () => {
  assert.equal(nextFile([true, false], 1, 1), -1);
});

test("nextFile with no selection picks the first shown file, or none", () => {
  assert.equal(nextFile([false, true, true], -1, 1), 1);
  assert.equal(nextFile([], -1, 1), -1);
});

test("selectionRange sorts its ends", () => {
  assert.deepEqual(selectionRange(5, 2), { from: 2, to: 5 });
  assert.deepEqual(selectionRange(2, 5), { from: 2, to: 5 });
});
