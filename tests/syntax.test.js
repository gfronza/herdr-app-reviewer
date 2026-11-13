import { test } from "node:test";
import assert from "node:assert/strict";
import { languageFor, createHighlighter, colorFor } from "../mods/reviewer/syntax.js";

function rowsOf(spec) {
  let old = 1;
  let neu = 1;
  return spec.map(([kind, text]) => {
    if (kind === "hunk") return { kind, old: null, new: null, text };
    const row = { kind, old: kind === "add" ? null : old, new: kind === "del" ? null : neu, text };
    if (kind !== "add") old++;
    if (kind !== "del") neu++;
    return row;
  });
}

function finish(h, budget) {
  let steps = 1;
  while (!h.step(budget)) {
    steps++;
    assert.ok(steps < 10000, "step() never finished");
  }
  return steps;
}

const scopes = (h, i) => [...new Set(h.runs(i).map((run) => run.scope))];
const joined = (h, i) => h.runs(i).map((run) => run.text).join("");

const tsDiff = rowsOf([
  ["hunk", "@@ -1,9 +1,11 @@"],
  ["ctx", "import { readFile } from \"node:fs/promises\";"],
  ["ctx", ""],
  ["del", "export async function load(path: string) {"],
  ["add", "export async function load(path: string, limit = 10): Promise<string[]> {"],
  ["ctx", "\tconst text = await readFile(path, \"utf8\"); // read it all"],
  ["del", "    return text.split(\"\\n\");"],
  ["add", "    /* keep only the head,"],
  ["add", "       the rest is noise */"],
  ["add", "    return text.split(`\\n`).slice(0, limit).map((l) => `${l.trim()}!`);"],
  ["ctx", "}"],
  ["hunk", "@@ -20,3 +22,3 @@"],
  ["ctx", "class Cache<T> extends Map<string, T> {"],
  ["del", "  private hits = 0;"],
  ["add", "  private hits = 0x1f;"],
  ["ctx", "}"],
]);

test("languageFor maps extensions and aliases to registered languages", () => {
  const cases = {
    "src/a.ts": "typescript",
    "a/b.tsx": "typescript",
    "x.mts": "typescript",
    "x.js": "javascript",
    "x.mjs": "javascript",
    "x.cjs": "javascript",
    "x.jsx": "javascript",
    "x.py": "python",
    "x.rs": "rust",
    "x.rb": "ruby",
    "ci.yml": "yaml",
    "run.sh": "bash",
    "README.md": "markdown",
    "a.h": "c",
    "a.hpp": "cpp",
    "a.kt": "kotlin",
    "tsconfig.jsonc": "json",
    "UPPER.TS": "typescript",
  };
  for (const [path, language] of Object.entries(cases)) assert.equal(languageFor(path), language, path);
});

test("languageFor returns null for unknown or missing extensions", () => {
  for (const path of ["notes.xyz", "Dockerfile", ".bashrc", "dir.v2/README", "a/b."]) {
    assert.equal(languageFor(path), null, path);
  }
});

test("runs of every row concatenate to the row text, for large and tiny batches", () => {
  for (const budget of [20000, 60, 1]) {
    const h = createHighlighter(tsDiff, "typescript");
    finish(h, budget);
    tsDiff.forEach((row, i) => {
      if (row.kind === "hunk") assert.equal(h.runs(i), null);
      else assert.equal(joined(h, i), row.text, `budget ${budget}, row ${i}`);
    });
  }
});

test("a realistic diff gets keyword, string, comment and title scopes", () => {
  const h = createHighlighter(tsDiff, "typescript");
  finish(h);
  assert.deepEqual(h.runs(1).slice(0, 2), [
    { text: "import", scope: "keyword" },
    { text: " { readFile } ", scope: null },
  ]);
  assert.deepEqual(h.runs(4).slice(0, 5), [
    { text: "export", scope: "keyword" },
    { text: " ", scope: null },
    { text: "async", scope: "keyword" },
    { text: " ", scope: null },
    { text: "function", scope: "keyword" },
  ]);
  assert.ok(h.runs(4).some((run) => run.scope === "title.function" && run.text === "load"));
  assert.ok(h.runs(5).some((run) => run.scope === "string" && run.text === "\"utf8\""));
  assert.deepEqual(h.runs(5).at(-1), { text: "// read it all", scope: "comment" });
  assert.deepEqual(scopes(h, 7), [null, "comment"]);
  assert.deepEqual(scopes(h, 8), ["comment"]);
  assert.ok(h.runs(9).some((run) => run.scope === "subst" && run.text === "${l.trim()}"));
});

const commentAcrossEdge = rowsOf([
  ["add", "const a = 1;"],
  ["add", "let b = 2;"],
  ["add", "/* one"],
  ["add", " two"],
  ["add", " three */"],
  ["add", "const c = 3;"],
]);

test("a block comment that crosses a batch edge is a comment on every line", () => {
  const h = createHighlighter(commentAcrossEdge, "typescript");
  assert.equal(h.step(40), false);
  finish(h, 40);
  for (const i of [2, 3, 4]) assert.deepEqual(scopes(h, i), ["comment"], `row ${i}`);
  assert.deepEqual(h.runs(5)[0], { text: "const", scope: "keyword" });
});

test("a template string that crosses a batch edge is a string on every line", () => {
  const rows = rowsOf([
    ["add", "const a = 1;"],
    ["add", "let b = 2;"],
    ["add", "const t = `one"],
    ["add", "  two words"],
    ["add", "  three`;"],
    ["add", "let c = 3;"],
  ]);
  const h = createHighlighter(rows, "typescript");
  finish(h, 40);
  assert.deepEqual(h.runs(2).at(-1), { text: "`one", scope: "string" });
  assert.deepEqual(scopes(h, 3), ["string"]);
  assert.deepEqual(h.runs(4), [{ text: "  three`", scope: "string" }, { text: ";", scope: null }]);
  assert.deepEqual(h.runs(5)[0], { text: "let", scope: "keyword" });
});

test("a batch edge right after a comment closes and a template opens on one line", () => {
  const rows = rowsOf([
    ["add", "let q = 1;"],
    ["add", "/* a"],
    ["add", "b */ const t = `x"],
    ["add", "  y"],
    ["add", "  z`;"],
    ["add", "let w = 2;"],
  ]);
  const h = createHighlighter(rows, "typescript");
  finish(h, 40);
  assert.deepEqual(h.runs(2), [
    { text: "b */", scope: "comment" },
    { text: " ", scope: null },
    { text: "const", scope: "keyword" },
    { text: " t = ", scope: null },
    { text: "`x", scope: "string" },
  ]);
  assert.deepEqual(scopes(h, 3), ["string"]);
});

test("a YAML block scalar that reaches a batch edge is a string on every line", () => {
  const lead = ["a: 1", "b: 2", "c: 3", "d: 4", "e: 5", "f: 6", "g: 7", "h: 8", "i: 9", "j: 0", "steps:"];
  const texts = [...lead, "  - run: |", "      echo one", "      echo two", "      echo three", "      echo four", "  - name: done"];
  const rows = rowsOf(texts.map((text) => ["ctx", text]));
  // The block from "run: |" to "echo four" is 72 chars, so it fits each budget along with the line
  // before it. The first batch ends after "run: |", "echo one" and "echo two" respectively.
  for (const budget of [80, 90, 105]) {
    const h = createHighlighter(rows, "yaml");
    finish(h, budget);
    for (const i of [12, 13, 14, 15]) assert.deepEqual(h.runs(i), [{ text: texts[i], scope: "string" }], `budget ${budget}, row ${i}`);
    assert.deepEqual(h.runs(16).at(-1), { text: "done", scope: "string" }, `budget ${budget}`);
  }
});

test("a construct longer than a whole batch still makes progress", () => {
  const spec = [["add", "let x = 1;"], ["add", "/* start"]];
  for (let i = 0; i < 200; i++) spec.push(["add", ` comment line ${i}`]);
  spec.push(["add", "end */"], ["add", "let y = 2;"]);
  const rows = rowsOf(spec);
  const h = createHighlighter(rows, "typescript");
  const steps = finish(h, 40);
  assert.ok(steps <= rows.length, `${steps} steps`);
  rows.forEach((row, i) => assert.equal(joined(h, i), row.text));
  assert.deepEqual(scopes(h, 1), ["comment"]);
  assert.deepEqual(scopes(h, 2), ["comment"]);
});

test("a 1500-line diff finishes in a few default-sized steps", () => {
  const spec = [["hunk", "@@ -1,750 +1,750 @@"]];
  for (let i = 0; i < 750; i++) {
    spec.push(["del", `export function f${i}(a: number): number { return a + ${i}; }`]);
    spec.push(["add", `export function f${i}(a: number): number { return a * ${i}; } // ${i}`]);
  }
  const rows = rowsOf(spec);
  const h = createHighlighter(rows, "typescript");
  const steps = finish(h);
  assert.ok(steps >= 2 && steps <= 5, `${steps} steps`);
  rows.forEach((row, i) => {
    if (i > 0) assert.equal(joined(h, i), row.text);
  });
  assert.deepEqual(h.runs(1500)[0], { text: "export", scope: "keyword" });
});

test("quick colors only the requested rows, and step later replaces them", () => {
  const spec = [["ctx", "/*"]];
  for (let i = 0; i < 30; i++) spec.push(["ctx", `const v${i} = ${i};`]);
  spec.push(["ctx", "*/"]);
  const rows = rowsOf(spec);
  const h = createHighlighter(rows, "typescript");
  h.quick(10, 20);
  assert.equal(h.runs(9), null);
  assert.equal(h.runs(20), null);
  // Standalone, the range does not know it sits inside a comment.
  assert.deepEqual(h.runs(10)[0], { text: "const", scope: "keyword" });
  assert.equal(joined(h, 19), rows[19].text);
  finish(h);
  for (const i of [9, 10, 19, 20]) assert.deepEqual(scopes(h, i), ["comment"], `row ${i}`);
});

test("quick leaves rows that step already colored", () => {
  const rows = rowsOf([["add", "/* a"], ["add", "const b = 1; */"], ["add", "let c;"]]);
  const h = createHighlighter(rows, "typescript");
  finish(h);
  const before = h.runs(1);
  h.quick(0, 3);
  assert.equal(h.runs(1), before);
  assert.deepEqual(scopes(h, 1), ["comment"]);
});

test("a line over 1000 chars stays uncolored and does not affect its neighbours", () => {
  const long = "/* " + "a".repeat(1200);
  const rows = rowsOf([["add", "const a = 1;"], ["add", long], ["add", "const b = 2;"]]);
  const h = createHighlighter(rows, "typescript");
  finish(h);
  assert.deepEqual(h.runs(1), [{ text: long, scope: null }]);
  assert.deepEqual(h.runs(0)[0], { text: "const", scope: "keyword" });
  assert.deepEqual(h.runs(2)[0], { text: "const", scope: "keyword" });

  const q = createHighlighter(rows, "typescript");
  q.quick(0, 3);
  assert.deepEqual(q.runs(1), [{ text: long, scope: null }]);
  assert.deepEqual(q.runs(2)[0], { text: "const", scope: "keyword" });
});

test("deleted rows are colored from the old side, added rows from the new side", () => {
  const rows = rowsOf([
    ["hunk", "@@ -1,4 +1,2 @@"],
    ["del", "/*"],
    ["del", " removed words"],
    ["del", "*/"],
    ["add", "const x = 1;"],
    ["ctx", "const y = 2;"],
  ]);
  const h = createHighlighter(rows, "typescript");
  finish(h);
  assert.equal(h.runs(0), null);
  assert.deepEqual(h.runs(2), [{ text: " removed words", scope: "comment" }]);
  assert.deepEqual(h.runs(4)[0], { text: "const", scope: "keyword" });
  assert.deepEqual(h.runs(5)[0], { text: "const", scope: "keyword" });
});

test("both sides carry a comment opened on a context row", () => {
  const rows = rowsOf([["ctx", "/*"], ["del", " gone words"], ["add", " added words"], ["ctx", "*/"], ["ctx", "let z;"]]);
  const h = createHighlighter(rows, "typescript");
  finish(h);
  assert.deepEqual(h.runs(1), [{ text: " gone words", scope: "comment" }]);
  assert.deepEqual(h.runs(2), [{ text: " added words", scope: "comment" }]);
  assert.deepEqual(h.runs(4)[0], { text: "let", scope: "keyword" });
});

test("context rows take their colors from the new side", () => {
  const rows = rowsOf([["del", "/* old comment"], ["add", "// new"], ["ctx", "const k = 1;"], ["del", "*/"]]);
  const h = createHighlighter(rows, "typescript");
  finish(h);
  assert.deepEqual(h.runs(2)[0], { text: "const", scope: "keyword" });
  assert.deepEqual(h.runs(3), [{ text: "*/", scope: "comment" }]);
});

test("doc tags and names inside a comment keep the comment scope", () => {
  const rows = rowsOf([["add", "/**"], ["add", " * @param {string} path - the file to read"], ["add", " */"]]);
  const h = createHighlighter(rows, "typescript");
  finish(h);
  assert.deepEqual(h.runs(1), [
    { text: " * @param {", scope: "comment" },
    { text: "string", scope: "type" },
    { text: "} path - the file to read", scope: "comment" },
  ]);
});

test("colorFor gives keyword, string and comment three different theme colors", () => {
  const theme = {
    foreground: "#eeeeee",
    dim: "#777777",
    ansi2: "#00aa00",
    ansi3: "#aaaa00",
    ansi4: "#0000aa",
    ansi5: "#aa00aa",
    ansi6: "#00aaaa",
  };
  assert.equal(colorFor("keyword", theme), "#aa00aa");
  assert.equal(colorFor("string", theme), "#00aa00");
  assert.equal(colorFor("comment", theme), "#777777");
  assert.equal(colorFor("title.class", theme), "#00aaaa");
  assert.equal(colorFor("title.function", theme), "#0000aa");
  assert.equal(colorFor("number", theme), "#aaaa00");
  assert.equal(colorFor("subst", theme), null);
  assert.equal(colorFor("variable.language", theme), null);
  assert.equal(colorFor("no-such-scope", theme), null);
  assert.equal(colorFor(null, theme), null);
});
