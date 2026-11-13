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

async function readNumstat(root, exec) {
  const out = await git(root, ["diff", "HEAD", "--numstat", "-z", "--no-renames"], exec);
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

export async function listChanges(root, exec, readText) {
  const head = await hasHead(root, exec);
  const [codes, stats] = await Promise.all([readStatus(root, exec), head ? readNumstat(root, exec) : new Map()]);
  const paths = [...codes.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const files = await Promise.all(paths.slice(0, MAX_FILES).map((path) => {
    const xy = codes.get(path);
    if (xy === "??" || !head) return newFile(root, path, xy, readText);
    const { add, del, binary } = stats.get(path) ?? { add: 0, del: 0, binary: false };
    return { path, status: statusOf(xy), add, del, untracked: false, binary };
  }));
  return { files, cut: paths.length > MAX_FILES };
}

// Text draws a tab as nothing: pad each to the next 4-column stop.
const untab = (text) => text.replace(/[^\t]*\t/g, (s) => s.slice(0, -1).padEnd(s.length - 1 - ((s.length - 1) % 4) + 4));

function rowText(raw) {
  const text = untab(raw.slice(0, MAX_LINE + 1));
  return text.length > MAX_LINE ? text.slice(0, MAX_LINE - 1) + "…" : text;
}

function capRows(rows) {
  return { rows: rows.slice(0, MAX_ROWS), cut: rows.length > MAX_ROWS, notice: null };
}

const BINARY = { rows: [], cut: false, notice: "Binary file · no text diff" };

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

export async function fileDiff(root, file, exec, readText) {
  if (file.untracked || !(await hasHead(root, exec))) {
    const text = await readText(`${root}/${file.path}`);
    return isBinary(text) ? BINARY : addedRows(text);
  }
  // Literal, so a name like "f[1].txt" or ":foo" cannot match another file.
  const out = await git(root, ["diff", "HEAD", "--no-ext-diff", "--no-textconv", "--no-color", "--", `:(literal)${file.path}`], exec);
  const rows = parseDiff(out);
  if (!rows.length && /^Binary files /m.test(out)) return BINARY;
  return capRows(rows);
}
