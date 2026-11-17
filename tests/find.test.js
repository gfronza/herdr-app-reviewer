import { test } from "node:test";
import assert from "node:assert/strict";
import { findRows, markRuns, nextMatch, searchFiles } from "../mods/reviewer/find.js";

const rows = [["ctx", "const Foo = 1;"], ["ctx", "bar()"], ["add", "return foo;"], ["hunk", "@@ -1 +1 @@ foo"], ["del", "FOO"]]
  .map(([kind, text]) => ({ kind, text }));
// Each run as "text" or "[text]" when it is a match.
const show = (runs) => runs.map((r) => (r.match ? `[${r.text}]` : r.text));

test("findRows: rows holding the text, ignoring case, but no hunk header", () => {
  assert.deepEqual(findRows(rows, "FOO"), [0, 2, 4]);
});

test("findRows: a file heading never matches", () => {
  assert.deepEqual(findRows([{ kind: "file", text: "foo.js" }, ...rows], "foo"), [1, 3, 5]);
});

test("findRows: an empty query or no hit finds nothing", () => {
  assert.deepEqual(findRows(rows, ""), []);
  assert.deepEqual(findRows(rows, "zzz"), []);
});

test("findRows: a line that changes length when lowercased matches with its case kept, any query case", () => {
  const lines = [{ kind: "ctx", text: "İstanbul ABC" }, { kind: "ctx", text: "y" }];
  assert.deepEqual(findRows(lines, "ABC"), [0]);
  assert.deepEqual(findRows(lines, "abc"), []);
});

test("markRuns: a line that changes length when lowercased marks the match at its true place", () => {
  assert.deepEqual(show(markRuns([{ text: "İstanbul x", scope: null }], "x")), ["İstanbul ", "[x]"]);
});

test("nextMatch: forward from a row finds the next match and wraps to the first", () => {
  assert.equal(nextMatch([2, 5, 9], 2, 1), 5);
  assert.equal(nextMatch([2, 5, 9], 9, 1), 2);
  assert.equal(nextMatch([2, 5, 9], -1, 1), 2);
});

test("nextMatch: backward finds the previous match and wraps to the last", () => {
  assert.equal(nextMatch([2, 5, 9], 5, -1), 2);
  assert.equal(nextMatch([2, 5, 9], 2, -1), 9);
});

test("nextMatch: no matches gives -1", () => {
  assert.equal(nextMatch([], 3, 1), -1);
});

test("markRuns: cuts runs at each match, keeping each run's scope", () => {
  const runs = [{ text: "return ", scope: "keyword" }, { text: "foo + Foo", scope: null }];
  const marked = markRuns(runs, "foo");
  assert.deepEqual(show(marked), ["return ", "[foo]", " + ", "[Foo]"]);
  assert.deepEqual(marked.map((r) => r.scope), ["keyword", null, null, null]);
});

test("markRuns: a match that crosses two runs is marked in both", () => {
  assert.deepEqual(show(markRuns([{ text: "ab", scope: "a" }, { text: "cd", scope: "b" }], "bc")), ["a", "[b]", "[c]", "d"]);
});

test("markRuns: without a query or a hit the runs come back unchanged", () => {
  const runs = [{ text: "abc", scope: null }];
  assert.equal(markRuns(runs, ""), runs);
  assert.equal(markRuns(runs, "x"), runs);
});

test("searchFiles: hits across files in file order, skipping hunk headers", () => {
  const files = [
    { entry: "a.js", rows: [{ kind: "hunk", text: "@@ foo" }, { kind: "add", text: "foo()" }, { kind: "ctx", text: "x" }] },
    { entry: "b.js", rows: [{ kind: "del", text: "FOO" }] },
  ];
  const { hits, more } = searchFiles(files, "foo", 10);
  assert.deepEqual(hits.map(({ entry, row }) => [entry, row]), [["a.js", 1], ["b.js", 0]]);
  assert.equal(hits[1].rows, files[1].rows);
  assert.equal(more, false);
});

test("searchFiles: stops at the limit and says more were left", () => {
  const files = [{ entry: "a", rows: [{ kind: "add", text: "x" }, { kind: "add", text: "x" }, { kind: "add", text: "x" }] }];
  const { hits, more } = searchFiles(files, "x", 2);
  assert.deepEqual(hits.map(({ entry, row }) => [entry, row]), [["a", 0], ["a", 1]]);
  assert.equal(more, true);
});

test("searchFiles: exactly the limit leaves nothing more", () => {
  const files = [{ entry: "a", rows: [{ kind: "add", text: "x" }, { kind: "add", text: "x" }] }];
  assert.equal(searchFiles(files, "x", 2).more, false);
});

test("searchFiles: an empty query finds nothing", () => {
  assert.deepEqual(searchFiles([{ entry: "a", rows: [{ kind: "add", text: "x" }] }], "", 5), { hits: [], more: false });
});
