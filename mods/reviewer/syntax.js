import hljs from "./vendor/highlight.min.js";

const MAX_LINE = 1000;

/** @typedef {{ text: string, scope: string | null }} Run */

const canonicalName = new Map(hljs.listLanguages().map((name) => [hljs.getLanguage(name), name]));

/** @returns {string | null} a registered highlight.js language name, or null when the extension has none. */
export function languageFor(path) {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return canonicalName.get(hljs.getLanguage(base.slice(dot + 1))) ?? null;
}

/**
 * Colors diff rows in character-sized batches. The new side (ctx + add) and the old side
 * (ctx + del) are parsed as two separate streams so each sees the code it belongs to.
 */
export function createHighlighter(rows, language) {
  const top = hljs.getLanguage(language);
  /** @type {(Run[] | null)[]} */
  const colored = rows.map(() => null);
  const newSide = sideOf(rows, (kind) => kind === "ctx" || kind === "add", (kind) => kind !== "del");
  const oldSide = sideOf(rows, (kind) => kind === "ctx" || kind === "del", (kind) => kind === "del");

  function store(side, indexes, lineRuns) {
    indexes.forEach((rowIndex, i) => {
      if (side.owns(rows[rowIndex].kind)) colored[rowIndex] = lineRuns[i];
    });
  }

  function advance(side, budget) {
    const indexes = takeBatch(rows, side.rows, side.pos, budget);
    const result = highlight(rows, indexes, language);
    const n = indexes.length;
    const ends = side.pos + n === side.rows.length;
    // Ending at top level is not enough: YAML matches a block scalar with one regex that needs its
    // header and two body lines, so a batch edge there leaves it unmatched. Unless the stream ends
    // here, the last two top-level lines are held back and re-parsed with what follows.
    const count = result.top !== top ? safeCut(result.root, n, 1) : ends ? n : safeCut(result.root, n, 2);
    store(side, indexes.slice(0, count), result.lineRuns);
    side.pos += count;
  }

  return {
    step(budget = 20000) {
      for (const side of [newSide, oldSide]) {
        if (side.pos < side.rows.length) advance(side, budget);
      }
      return newSide.pos === newSide.rows.length && oldSide.pos === oldSide.rows.length;
    },
    quick(start, end) {
      for (const side of [newSide, oldSide]) {
        const indexes = side.rows.filter((i) => i >= start && i < end);
        if (!indexes.some((i) => colored[i] === null)) continue;
        const { lineRuns } = highlight(rows, indexes, language);
        indexes.forEach((rowIndex, i) => {
          if (colored[rowIndex] === null && side.owns(rows[rowIndex].kind)) colored[rowIndex] = lineRuns[i];
        });
      }
    },
    runs: (rowIndex) => colored[rowIndex],
  };
}

function sideOf(rows, includes, owns) {
  const indexes = [];
  rows.forEach((row, i) => {
    if (includes(row.kind)) indexes.push(i);
  });
  return { rows: indexes, pos: 0, owns };
}

function takeBatch(rows, sideRows, pos, budget) {
  const indexes = [sideRows[pos]];
  let chars = feed(rows[sideRows[pos]].text).length + 1;
  for (let i = pos + 1; i < sideRows.length; i++) {
    const cost = feed(rows[sideRows[i]].text).length + 1;
    if (chars + cost > budget) break;
    chars += cost;
    indexes.push(sideRows[i]);
  }
  return indexes;
}

// Overlong lines (typically minified code) cost ~7 ms per KB, so they are parsed as empty.
function feed(text) {
  return text.length > MAX_LINE ? "" : text;
}

const plain = (text) => [{ text, scope: null }];

function highlight(rows, indexes, language) {
  const texts = indexes.map((i) => rows[i].text);
  const result = hljs.highlight(texts.map(feed).join("\n"), { language, ignoreIllegals: true });
  const root = result._emitter.rootNode;
  // highlight.js returns a partial tree when a grammar throws; show those lines plain.
  const lineRuns = result.errorRaised ? texts.map(plain) : splitLines(root, texts.length);
  texts.forEach((text, i) => {
    if (text.length > MAX_LINE) lineRuns[i] = plain(text);
  });
  return { top: result._top, root, lineRuns };
}

/** Flattens the token tree into runs per line, each run carrying its innermost scope. */
function splitLines(root, lineCount) {
  /** @type {Run[][]} */
  const lines = Array.from({ length: lineCount }, () => []);
  let line = 0;
  const push = (text, scope) => {
    const runs = lines[line];
    const last = runs[runs.length - 1];
    if (last && last.scope === scope) last.text += text;
    else runs.push({ text, scope });
  };
  const walk = (node, scope) => {
    for (const child of node.children) {
      if (typeof child !== "string") {
        walk(child, innerScope(child.scope, scope));
        continue;
      }
      child.split("\n").forEach((piece, i) => {
        if (i > 0) line++;
        if (piece) push(piece, scope);
      });
    }
  };
  walk(root, null);
  return lines;
}

function innerScope(scope, outer) {
  // Sub-language roots are scoped "language:x"; their plain text keeps the outer color.
  if (!scope || scope.startsWith("language:")) return outer;
  // A doc tag or name inside a comment would otherwise draw brighter than the comment.
  if (outer === "comment" && !colorKey(scope)) return outer;
  return scope;
}

/**
 * Returns how many lines to accept: up to the `keep`-th last line that starts at top level (its
 * preceding newline is plain root text), so the next batch re-parses from a clean state. With no
 * such line, the construct has been open since the first line and the whole batch is accepted.
 */
function safeCut(root, lineCount, keep) {
  const starts = [];
  let line = 0;
  for (const child of root.children) {
    if (typeof child !== "string") line += countNewlines(child);
    else for (let i = countNewlines(child); i > 0; i--) starts.push(++line);
  }
  return starts[starts.length - keep] ?? starts.at(-1) ?? lineCount;
}

function countNewlines(node) {
  if (typeof node === "string") return node.split("\n").length - 1;
  return node.children.reduce((sum, child) => sum + countNewlines(child), 0);
}

const SCOPE_COLORS = {
  comment: "dim",
  keyword: "ansi5",
  string: "ansi2",
  regexp: "ansi2",
  char: "ansi2",
  number: "ansi3",
  literal: "ansi3",
  symbol: "ansi3",
  title: "ansi4",
  function: "ansi4",
  section: "ansi4",
  type: "ansi6",
  built_in: "ansi6",
  "title.class": "ansi6",
  attr: "ansi4",
  attribute: "ansi4",
  property: "ansi4",
  meta: "ansi6",
};

/** @returns {string | null} the theme color for a scope, or null to draw it as plain text. */
export function colorFor(scope, theme) {
  const key = scope && colorKey(scope);
  return key ? (theme[key] ?? null) : null;
}

function colorKey(scope) {
  return SCOPE_COLORS[scope] ?? SCOPE_COLORS[scope.split(".")[0]];
}
