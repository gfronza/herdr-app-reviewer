import { test } from "node:test";
import assert from "node:assert/strict";
import { createComment, locate, formatReview } from "../mods/reviewer/review.js";

const hunk = (text) => ({ kind: "hunk", old: null, new: null, text });
const ctx = (old, nu, text) => ({ kind: "ctx", old, new: nu, text });
const add = (nu, text) => ({ kind: "add", old: null, new: nu, text });
const del = (old, text) => ({ kind: "del", old, new: null, text });

const fileRows = [
  hunk("@@ -1,4 +1,5 @@"),
  ctx(1, 1, "one"),
  del(2, "two"),
  add(2, "TWO"),
  add(3, "extra"),
  ctx(3, 4, "three"),
  ctx(4, 5, "four"),
  hunk("@@ -10,3 +11,1 @@"),
  ctx(10, 11, "ten"),
  del(11, "eleven"),
  del(12, "twelve"),
];

const comment = (from, to, rows = fileRows) =>
  createComment({ id: "c1", root: "/work/repo", path: "a.js", rows, from, to, text: "note" });

test("createComment on one line", () => {
  assert.deepEqual(comment(5, 5), {
    id: "c1",
    root: "/work/repo",
    path: "a.js",
    anchors: [{ key: "n:4", mark: " ", text: "three", at: 3 }],
    text: "note",
  });
});

test("createComment covers a four-line range given in either order", () => {
  const expected = [
    { key: "n:1", mark: " ", text: "one", at: 1 },
    { key: "o:2", mark: "-", text: "two", at: 2 },
    { key: "n:2", mark: "+", text: "TWO", at: 3 },
    { key: "n:3", mark: "+", text: "extra", at: 3 },
  ];
  assert.deepEqual(comment(1, 4).anchors, expected);
  assert.deepEqual(comment(4, 1).anchors, expected);
});

test("createComment skips a hunk header inside the range", () => {
  assert.deepEqual(comment(6, 8).anchors, [
    { key: "n:5", mark: " ", text: "four", at: 4 },
    { key: "n:11", mark: " ", text: "ten", at: 10 },
  ]);
});

test("createComment on deletions only anchors to old line numbers", () => {
  assert.deepEqual(comment(9, 10).anchors, [
    { key: "o:11", mark: "-", text: "eleven", at: 11 },
    { key: "o:12", mark: "-", text: "twelve", at: 12 },
  ]);
});

test("createComment refuses a range with no lines", () => {
  assert.throws(() => comment(0, 0), /at least one diff line/);
});

const base = [hunk("@@ -1,3 +1,4 @@"), ctx(1, 1, "alpha"), ctx(2, 2, "beta"), add(3, "gamma"), ctx(3, 4, "delta")];

test("locate finds unchanged rows as not stale", () => {
  assert.deepEqual(locate(comment(3, 4, base), base), { start: 3, end: 4, stale: false });
});

test("locate follows a line pushed down by lines inserted above", () => {
  const shifted = [
    hunk("@@ -1,3 +1,6 @@"),
    ctx(1, 1, "alpha"),
    add(2, "new one"),
    add(3, "new two"),
    ctx(2, 4, "beta"),
    add(5, "gamma"),
    ctx(3, 6, "delta"),
  ];
  assert.deepEqual(locate(comment(3, 4, base), shifted), { start: 5, end: 6, stale: false });
});

test("locate marks a comment stale when its line's text changed", () => {
  const edited = base.map((row) => (row.text === "gamma" ? add(3, "GAMMA") : row));
  assert.deepEqual(locate(comment(3, 3, base), edited), { start: 3, end: 3, stale: true });
});

test("locate falls back to the next line on the same side when the line is gone", () => {
  const before = [hunk("@@ -4,4 +4,3 @@"), ctx(4, 4, "a"), del(5, "gone"), ctx(6, 5, "b"), ctx(7, 6, "c")];
  const after = [hunk("@@ -6,2 +6,2 @@"), ctx(6, 6, "b"), ctx(7, 7, "c")];
  assert.deepEqual(locate(comment(2, 2, before), after), { start: 1, end: 1, stale: true });
});

// Hunk 1 holds the commented "}" at line 50; hunk 2 holds an identical "}" at line 72.
const braces = [
  hunk("@@ -48,3 +48,3 @@"),
  ctx(48, 48, "  x();"),
  del(49, "  a;"),
  add(49, "  b;"),
  ctx(50, 50, "}"),
  hunk("@@ -70,3 +70,3 @@"),
  ctx(70, 70, "  y();"),
  del(71, "  c;"),
  add(71, "  d;"),
  ctx(72, 72, "}"),
];

test("locate marks an edited line stale even when an identical line exists elsewhere", () => {
  const edited = [
    ...braces.slice(0, 4),
    del(50, "}"),
    add(50, "} // edited"),
    ...braces.slice(5),
  ];
  assert.deepEqual(locate(comment(4, 4, braces), edited), { start: 4, end: 4, stale: true });
});

test("locate follows a shifted line past an identical line nearer its old number", () => {
  const shifted = [
    hunk("@@ -1,1 +1,11 @@"),
    ctx(1, 1, "top"),
    ...Array.from({ length: 10 }, (_, k) => add(2 + k, `ins${k}`)),
    hunk("@@ -44,2 +54,2 @@"),
    del(44, "  q;"),
    add(54, "  r;"),
    ctx(45, 55, "}"),
    hunk("@@ -48,3 +58,3 @@"),
    ctx(48, 58, "  x();"),
    del(49, "  a;"),
    add(59, "  b;"),
    ctx(50, 60, "}"),
  ];
  assert.deepEqual(locate(comment(4, 4, braces), shifted), { start: 20, end: 20, stale: false });
});

test("locate returns -1 when nothing matches", () => {
  assert.deepEqual(locate(comment(3, 3, base), []), { start: -1, end: -1, stale: true });
});

test("formatReview groups by repo, then orders by file and line (AC-23)", () => {
  const removedRows = [hunk("@@ -10,2 +9,0 @@"), del(10, "const a = 1;"), del(11, "const b = 2;")];
  const rangeRows = [
    hunk("@@ -11,3 +11,3 @@"),
    ctx(11, 11, "function f() {"),
    del(12, "  return 1;"),
    add(12, "  return 2;"),
    ctx(13, 13, "}"),
  ];
  const importRows = [hunk("@@ -2,0 +3,1 @@"), add(3, "import x from 'x';")];
  const comments = [
    createComment({ id: "b2", root: "/work/repo-b", path: "src/b.js", rows: importRows, from: 1, to: 1, text: "Unused import." }),
    createComment({ id: "a1", root: "/work/repo-a", path: "lib/x.js", rows: removedRows, from: 1, to: 2, text: "Why remove these?" }),
    createComment({
      id: "b1",
      root: "/work/repo-b",
      path: "src/a.js",
      rows: rangeRows,
      from: 3,
      to: 1,
      text: "Return 2 breaks callers.\nKeep 1.",
    }),
  ];
  assert.equal(
    formatReview(comments, new Set(["b1"])),
    [
      "Code review comments",
      "",
      "/work/repo-a",
      "",
      "lib/x.js:10-11 (removed)",
      "    - const a = 1;",
      "    - const b = 2;",
      "Why remove these?",
      "",
      "/work/repo-b",
      "",
      "src/a.js:11-12 (lines changed since this comment)",
      "      function f() {",
      "    -   return 1;",
      "    +   return 2;",
      "Return 2 breaks callers.",
      "Keep 1.",
      "",
      "src/b.js:3",
      "    + import x from 'x';",
      "Unused import.",
    ].join("\n"),
  );
});

test("formatReview orders comments in one file by first line", () => {
  const late = { id: "x", root: "/r", path: "f.js", anchors: [{ key: "n:20", mark: "+", text: "late" }], text: "B" };
  const early = { id: "y", root: "/r", path: "f.js", anchors: [{ key: "n:5", mark: " ", text: "early" }], text: "A" };
  assert.equal(
    formatReview([late, early]),
    "Code review comments\n\n/r\n\nf.js:5\n      early\nA\n\nf.js:20\n    + late\nB",
  );
});

test("formatReview names the scope of a comment made outside the uncommitted changes", () => {
  const anchors = [{ key: "n:4", mark: "+", text: "x" }];
  const comments = [
    { id: "a", root: "/r", path: "f.js", anchors, text: "In a commit.", scope: { key: "commits:1:1", label: "commit a1b2c3d" } },
    { id: "b", root: "/r", path: "g.js", anchors, text: "Uncommitted.", scope: { key: "uncommitted", label: null } },
  ];
  assert.equal(
    formatReview(comments, new Set(["a"])),
    "Code review comments\n\n/r\n\nf.js:4 (in commit a1b2c3d) (lines changed since this comment)\n    + x\nIn a commit.\n\ng.js:4\n    + x\nUncommitted.",
  );
});
