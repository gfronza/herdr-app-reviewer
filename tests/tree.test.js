import { test } from "node:test";
import assert from "node:assert/strict";
import { fileRows } from "../mods/reviewer/tree.js";

const entries = (...paths) => paths.map((path) => ({ file: { path } }));
// One line per row: folders end in "/", with their file count when closed; two spaces per level.
const show = (rows) => rows.map((r) => "  ".repeat(r.depth) + (r.dir ? `${r.name}/${r.closed ? ` (${r.count})` : ""}` : r.name));

test("tree: folders first, then files, each by name, nested under their folder", () => {
  const rows = fileRows(entries("z.md", "b/y.js", "a.txt", "b/c/x.js", "b/a.js"), true, "g", new Set());
  assert.deepEqual(show(rows), ["b/", "  c/", "    x.js", "  a.js", "  y.js", "a.txt", "z.md"]);
});

test("tree: a chain of single-folder folders shares one row", () => {
  const rows = fileRows(entries("src/app/ui/button.js", "src/app/ui/list.js", "src/main.js"), true, "g", new Set());
  assert.deepEqual(show(rows), ["src/", "  app/ui/", "    button.js", "    list.js", "  main.js"]);
});

test("tree: a lone file deep in folders is one folder row and the file", () => {
  assert.deepEqual(show(fileRows(entries("a/b/c/d.txt"), true, "g", new Set())), ["a/b/c/", "  d.txt"]);
});

test("tree: a closed folder hides its files and counts every file under it", () => {
  const rows = fileRows(entries("lib/a.js", "lib/deep/b.js", "lib/deep/c.js", "x.js"), true, "g", new Set(["g\0lib"]));
  assert.deepEqual(show(rows), ["lib/ (3)", "x.js"]);
});

test("tree: a nested folder's key holds its whole path, so a same-named folder elsewhere stays open", () => {
  const rows = fileRows(entries("a/lib/x.js", "a/top.js", "b/lib/y.js", "b/top.js"), true, "g", new Set(["g\0a/lib"]));
  assert.deepEqual(show(rows), ["a/", "  lib/ (1)", "  top.js", "b/", "  lib/", "    y.js", "  top.js"]);
});

test("tree: a shared row closes by the whole chain it shows", () => {
  const rows = fileRows(entries("src/app/ui/button.js", "src/main.js"), true, "g", new Set(["g\0src/app/ui"]));
  assert.deepEqual(show(rows), ["src/", "  app/ui/ (1)", "  main.js"]);
});

test("tree: a folder key belongs to its group, so the same folder in another group stays open", () => {
  const rows = fileRows(entries("lib/a.js"), true, "other", new Set(["g\0lib"]));
  assert.deepEqual(show(rows), ["lib/", "  a.js"]);
});

test("tree: file rows carry the entry they stand for", () => {
  const list = entries("b/one.js", "a.js");
  const rows = fileRows(list, true, "g", new Set());
  assert.deepEqual(rows.filter((r) => !r.dir).map((r) => r.entry), [list[0], list[1]]);
});

test("flat: every file in the given order, folder path first, with no folder rows", () => {
  const rows = fileRows(entries("b/c/y.js", "a.txt"), false, "g", new Set(["g\0b"]));
  assert.deepEqual(rows.map((r) => [r.prefix, r.name, r.depth]), [["b/c/", "y.js", 0], ["", "a.txt", 0]]);
});

test("tree: no files gives no rows", () => {
  assert.deepEqual(fileRows([], true, "g", new Set()), []);
});
