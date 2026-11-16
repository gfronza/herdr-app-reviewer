import { test } from "node:test";
import assert from "node:assert/strict";
import { wrapRuns, wrappedLines } from "../mods/reviewer/wrap.js";

// One string per screen line: each piece as text, with its scope after a colon and * when matched.
const show = (lines) => lines.map((line) => line.map((r) => `${r.text}${r.scope ? `:${r.scope}` : ""}${r.match ? "*" : ""}`).join(" "));

test("wrapRuns: a line that fits stays one line, untouched", () => {
  const runs = [{ text: "const ", scope: "keyword" }, { text: "x = 1;", scope: null }];
  assert.deepEqual(show(wrapRuns(runs, 20)), ["const :keyword x = 1;"]);
});

test("wrapRuns: a long run breaks at the column", () => {
  assert.deepEqual(show(wrapRuns([{ text: "abcdefghij", scope: null }], 4)), ["abcd", "efgh", "ij"]);
});

test("wrapRuns: a run that crosses a break keeps its scope and match mark on both lines", () => {
  const runs = [{ text: "let ", scope: "keyword" }, { text: "\"hello\"", scope: "string", match: true }, { text: ";", scope: null }];
  assert.deepEqual(show(wrapRuns(runs, 6)), ["let :keyword \"h:string*", "ello\":string* ;"]);
});

test("wrapRuns: an empty line is one empty line, and a line exactly the width adds none", () => {
  assert.deepEqual(wrapRuns([], 8), [[]]);
  assert.deepEqual(wrapRuns([{ text: "", scope: null }], 8), [[]]);
  assert.deepEqual(show(wrapRuns([{ text: "12345678", scope: null }], 8)), ["12345678"]);
});

test("wrapRuns: a width under one column still makes progress, a character a line", () => {
  assert.deepEqual(show(wrapRuns([{ text: "abc", scope: null }], 0)), ["a", "b", "c"]);
});

test("wrappedLines: counts the lines wrapRuns makes, from the length alone", () => {
  for (const [length, cols] of [[0, 8], [8, 8], [9, 8], [100, 7], [3, 0]]) {
    assert.equal(wrappedLines(length, cols), wrapRuns([{ text: "x".repeat(length), scope: null }], cols).length, `${length} at ${cols}`);
  }
});
