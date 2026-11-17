import { test } from "node:test";
import assert from "node:assert/strict";
import { joinDiffs, keepCursor, partAt } from "../mods/reviewer/all.js";

const rows = (...texts) => texts.map((text) => ({ kind: "ctx", text }));
const a = { key: "a", rows: rows("a1", "a2") };
const b = { key: "b", rows: [] };
const c = { key: "c", rows: rows("c1", "c2", "c3") };

test("joinDiffs: headed, each file's rows follow a heading row, and each part says where it sits", () => {
  const { rows: all, parts } = joinDiffs([a, b, c], true);
  assert.deepEqual(all.map((r) => r.kind === "file" ? "#" : r.text), ["#", "a1", "a2", "#", "#", "c1", "c2", "c3"]);
  assert.deepEqual(parts.map((p) => [p.key, p.start, p.offset]), [["a", 0, 1], ["b", 3, 4], ["c", 4, 5]]);
});

test("joinDiffs: one file, not headed, is its own rows at offset 0", () => {
  const { rows: all, parts } = joinDiffs([c], false);
  assert.deepEqual(all.map((r) => r.text), ["c1", "c2", "c3"]);
  assert.deepEqual(parts.map((p) => [p.key, p.start, p.offset]), [["c", 0, 0]]);
});

test("partAt: a row belongs to its file, a heading to the file below it", () => {
  const { parts } = joinDiffs([a, b, c], true);
  assert.deepEqual([0, 1, 2, 3, 4, 5, 7].map((i) => partAt(parts, i).key), ["a", "a", "a", "b", "c", "c", "c"]);
  assert.equal(partAt([], 0), null);
});

test("keepCursor: the cursor stays on its file's row when files above it grow or go", () => {
  const before = joinDiffs([a, b, c], true);
  const after = joinDiffs([{ key: "a", rows: rows("a1", "a2", "a3", "a4") }, c], true);
  assert.equal(keepCursor(before, 6, after), 7);
  // Its heading stays its heading.
  assert.equal(keepCursor(before, 4, after), 5);
});

test("keepCursor: a file that got shorter keeps the cursor on its last row", () => {
  const before = joinDiffs([a, c], true);
  const after = joinDiffs([a, { key: "c", rows: rows("c1") }], true);
  assert.equal(keepCursor(before, 6, after), 4);
});

test("keepCursor: switching between one file and all files keeps the row in that file", () => {
  const one = joinDiffs([c], false), all = joinDiffs([a, b, c], true);
  assert.equal(keepCursor(one, 1, all), 6);
  assert.equal(keepCursor(all, 6, one), 1);
});

test("keepCursor: a file that is gone leaves the cursor at its place in the list, inside it", () => {
  const before = joinDiffs([a, c], true);
  assert.equal(keepCursor(before, 5, joinDiffs([a, b], true)), 3);
  assert.equal(keepCursor(null, 3, joinDiffs([c], false)), 2);
  assert.equal(keepCursor(before, 2, joinDiffs([b], false)), 0);
});
