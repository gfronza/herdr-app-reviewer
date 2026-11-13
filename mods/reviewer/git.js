// Reads write nothing under .git (no index refresh or lock, no fsmonitor cookie):
// the reviewer must never change a watched repo, and a folder watch would see the write.
export const READ = ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"];

const MAX_FILES = 1000;
const MAX_ROWS = 1500;
const MAX_LINE = 4000;

async function git(root, args, exec) {
  const r = await exec("git", [...READ, ...args], { cwd: root });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed in ${root}: ${r.stderr.trim()}`);
  return r.stdout;
}

const hasHead = async (root, exec) =>
  (await exec("git", [...READ, "rev-parse", "--verify", "--quiet", "HEAD"], { cwd: root })).code === 0;

export async function resolveFolder(folder, exec) {
  const r = await exec("git", [...READ, "-C", folder, "rev-parse", "--show-toplevel"], { cwd: "/" });
  if (r.code === 0) return { folder, state: "repo", root: r.stdout.replace(/\n$/, "") };
  // git prints this when -C cannot enter the folder: it is gone, or is not a folder.
  if (r.stderr.includes("cannot change to")) return { folder, state: "missing" };
  return { folder, state: "not-repo" };
}

const lineCount = (text) => (text ? text.split("\n").length - Number(text.endsWith("\n")) : 0);
const isBinary = (text) => text === null || text.includes("\0");

function statusOf(xy) {
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "U";
  if (xy.includes("D")) return "D";
  if (xy === "??" || xy.includes("A")) return "A";
  return "M";
}

// Maps path -> XY code. Tracked entries come before untracked ones, so a path listed
// twice (removed from the index but still on disk) keeps its tracked state.
// An untracked path ending in "/" is a nested repo, whose files belong to that repo.
async function readStatus(root, exec) {
  const out = await git(root, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all"], exec);
  const codes = new Map();
  for (const entry of out.split("\0")) {
    const path = entry.slice(3);
    if (entry && !codes.has(path) && !path.endsWith("/")) codes.set(path, entry.slice(0, 2));
  }
  return codes;
}

// Maps path -> a status letter (?? when untracked), for a diff between two commits or a commit and the
// working tree (`to` null); untracked files count only against the working tree.
async function readRangeStatus(root, range, exec) {
  const [names, others] = await Promise.all([
    git(root, ["diff", "--name-status", "-z", "--no-renames", ...revs(range)], exec),
    range.to ? "" : git(root, ["ls-files", "--others", "--exclude-standard", "-z"], exec),
  ]);
  const codes = new Map(), parts = names.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) codes.set(parts[i + 1], parts[i]);
  // A path dropped from the index but kept on disk keeps its tracked state, as in readStatus.
  for (const path of others.split("\0")) if (path && !path.endsWith("/") && !codes.has(path)) codes.set(path, "??");
  return codes;
}

const revs = (range) => (range ? (range.to ? [range.from, range.to] : [range.from]) : ["HEAD"]);

async function readNumstat(root, range, exec) {
  const out = await git(root, ["diff", ...revs(range), "--numstat", "-z", "--no-renames"], exec);
  const stats = new Map();
  for (const entry of out.split("\0")) {
    const [add, del, ...rest] = entry.split("\t");
    if (rest.length) stats.set(rest.join("\t"), { add: Number(add) || 0, del: Number(del) || 0, binary: add === "-" });
  }
  return stats;
}

// A file not in HEAD is all added, as fileDiff shows it, whatever the index holds.
async function newFile(root, path, xy, readText) {
  const text = await readText(`${root}/${path}`);
  const binary = isBinary(text);
  return { path, status: statusOf(xy), add: binary ? 0 : lineCount(text), del: 0, untracked: xy === "??", binary };
}

// The app rejects a mod's host call once 1024 are outstanding, so reads go in small waves.
const READS_AT_ONCE = 32;

async function mapInWaves(items, fn) {
  const out = [];
  for (let i = 0; i < items.length; i += READS_AT_ONCE) out.push(...(await Promise.all(items.slice(i, i + READS_AT_ONCE).map(fn))));
  return out;
}

/**
 * Commit or tree ids; a null `to` is the working tree. `objects` is a private object folder that
 * holds the trees of a turn snapshot.
 * @typedef {{ from: string, to: string | null, objects?: string }} Range
 */

// git reads an alternate object folder but never writes to it. Quoted, since the list splits on ":".
export const alternates = (dir) => `GIT_ALTERNATE_OBJECT_DIRECTORIES="${dir.replace(/[\\"]/g, "\\$&")}"`;
const withObjects = (exec, range) => (range?.objects ? (cmd, args, opts) => exec("env", [alternates(range.objects), cmd, ...args], opts) : exec);

/**
 * Without a range, every uncommitted change; with one, the diff across that range.
 * @param {Range} [range]
 */
export async function listChanges(root, exec, readText, range) {
  exec = withObjects(exec, range);
  const head = range ? true : await hasHead(root, exec);
  const [codes, stats] = await Promise.all([
    range ? readRangeStatus(root, range, exec) : readStatus(root, exec),
    head ? readNumstat(root, range, exec) : new Map(),
  ]);
  // Without an index refresh, a diff against the working tree names files whose stat changed but
  // whose content did not; numstat compares content and leaves those out.
  const paths = [...codes.keys()].filter((p) => !range || codes.get(p) === "??" || stats.has(p))
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const files = await mapInWaves(paths.slice(0, MAX_FILES), (path) => {
    const xy = codes.get(path);
    if (xy === "??" || !head) return newFile(root, path, xy, readText);
    const { add, del, binary } = stats.get(path) ?? { add: 0, del: 0, binary: false };
    return { path, status: statusOf(xy), add, del, untracked: false, binary };
  });
  return { files, cut: paths.length > MAX_FILES };
}

// Text draws a tab as nothing: pad each to the next 4-column stop. A split, not a regex:
// /[^\t]*\t/g rescans the rest of a long tabless line from every position.
function untab(text) {
  const parts = text.split("\t");
  let out = parts[0];
  for (let i = 1; i < parts.length; i++) out = out.padEnd(out.length - (out.length % 4) + 4) + parts[i];
  return out;
}

function rowText(raw) {
  const text = untab(raw.slice(0, MAX_LINE + 1));
  return text.length > MAX_LINE ? text.slice(0, MAX_LINE - 1) + "…" : text;
}

function capRows(rows) {
  return { rows: rows.slice(0, MAX_ROWS), cut: rows.length > MAX_ROWS, notice: null };
}

const BINARY = { rows: [], cut: false, notice: "Binary file · no text diff" };
// readTextFile gives null past 1 MiB, and the mod passes null for bytes that are not UTF-8.
const UNREADABLE = { rows: [], cut: false, notice: "Not shown: over 1 MiB, or not UTF-8 text" };

function addedRows(text) {
  const n = lineCount(text);
  if (!n) return { rows: [], cut: false, notice: null };
  const lines = text.split("\n", Math.min(n, MAX_ROWS));
  const rows = [{ kind: "hunk", old: null, new: null, text: `@@ -0,0 +1,${n} @@` }];
  lines.forEach((line, i) => rows.push({ kind: "add", old: null, new: i + 1, text: rowText(line) }));
  return { rows: rows.slice(0, MAX_ROWS), cut: n + 1 > MAX_ROWS, notice: null };
}

function parseDiff(out) {
  const rows = [];
  let old = 0, next = 0, inHunk = false;
  for (const line of out.split("\n")) {
    if (rows.length > MAX_ROWS) break;
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (header) {
      old = Number(header[1]); next = Number(header[2]); inHunk = true;
      rows.push({ kind: "hunk", old: null, new: null, text: rowText(line) });
    } else if (line.startsWith("diff ")) inHunk = false;
    else if (!inHunk) continue;
    else if (line[0] === "+") rows.push({ kind: "add", old: null, new: next++, text: rowText(line.slice(1)) });
    else if (line[0] === "-") rows.push({ kind: "del", old: old++, new: null, text: rowText(line.slice(1)) });
    else if (line[0] === " ") rows.push({ kind: "ctx", old: old++, new: next++, text: rowText(line.slice(1)) });
  }
  return rows;
}

/** @param {Range} [range] */
export async function fileDiff(root, file, exec, readText, range) {
  exec = withObjects(exec, range);
  if (file.untracked || (!range && !(await hasHead(root, exec)))) {
    const text = await readText(`${root}/${file.path}`);
    if (text === null) return UNREADABLE;
    return text.includes("\0") ? BINARY : addedRows(text);
  }
  // Literal, so a name like "f[1].txt" or ":foo" cannot match another file.
  const out = await git(root, ["diff", ...revs(range), "--no-ext-diff", "--no-textconv", "--no-color", "--", `:(literal)${file.path}`], exec);
  const rows = parseDiff(out);
  if (!rows.length && /^Binary files /m.test(out)) return BINARY;
  return capRows(rows);
}
