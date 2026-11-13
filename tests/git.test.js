import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { READ, resolveFolder, listChanges, fileDiff } from "../mods/reviewer/git.js";

// Keep the user's git config (signing, hooks, excludes) out of the fixtures.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const exec = (cmd, args, { cwd }) => new Promise((resolve) => {
  execFile(cmd, args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
  });
});
const readText = async (p) => { try { return await fs.promises.readFile(p, "utf8"); } catch { return null; } };

const gitIn = (dir, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
const write = (dir, rel, content) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), content);
};

// A repo whose first commit holds `files`; returns its real path (git reports realpaths).
function makeRepo(files = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-git-")));
  gitIn(dir, "init", "-q", "-b", "main");
  if (Object.keys(files).length) {
    for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
    gitIn(dir, "add", "-A");
    gitIn(dir, "commit", "-q", "-m", "init");
  }
  return dir;
}

test("READ holds the flags that keep git from writing", () => {
  assert.deepEqual(READ, ["--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false"]);
});

test("resolveFolder: a subfolder resolves to the repo top level", async () => {
  const root = makeRepo({ "src/a.txt": "a\n" });
  assert.deepEqual(await resolveFolder(path.join(root, "src"), exec), { folder: path.join(root, "src"), state: "repo", root });
  assert.deepEqual(await resolveFolder(root, exec), { folder: root, state: "repo", root });
});

test("resolveFolder: a folder outside any repo, a missing folder, and a file", async () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-plain-"));
  fs.writeFileSync(path.join(plain, "f"), "x");
  assert.deepEqual(await resolveFolder(plain, exec), { folder: plain, state: "not-repo" });
  assert.deepEqual(await resolveFolder(path.join(plain, "gone"), exec), { folder: path.join(plain, "gone"), state: "missing" });
  assert.deepEqual(await resolveFolder(path.join(plain, "f"), exec), { folder: path.join(plain, "f"), state: "missing" });
});

test("listChanges: staged, unstaged and untracked are listed, ignored is not", async () => {
  const root = makeRepo({ ".gitignore": "*.log\n", "staged.txt": "1\n2\n3\n", "unstaged.txt": "a\nb\n" });
  write(root, "staged.txt", "1\ntwo\n3\n4\n");
  gitIn(root, "add", "staged.txt");
  write(root, "unstaged.txt", "a\n");
  write(root, "new.txt", "x\ny\nz\n");
  write(root, "debug.log", "ignored\n");
  assert.deepEqual(await listChanges(root, exec, readText), {
    cut: false,
    files: [
      { path: "new.txt", status: "A", add: 3, del: 0, untracked: true, binary: false },
      { path: "staged.txt", status: "M", add: 2, del: 1, untracked: false, binary: false },
      { path: "unstaged.txt", status: "M", add: 0, del: 1, untracked: false, binary: false },
    ],
  });
});

test("listChanges: deleted, binary, and paths with spaces, tabs, quotes, non-ASCII", async () => {
  const root = makeRepo({ "gone.txt": "a\nb\n", "img.bin": Buffer.from([0, 1, 2, 3]) });
  fs.rmSync(path.join(root, "gone.txt"));
  fs.writeFileSync(path.join(root, "img.bin"), Buffer.from([0, 9, 9]));
  write(root, "my dir/a file.txt", "one\n");
  write(root, "tab\there \"q\" é.txt", "1\n2");
  fs.writeFileSync(path.join(root, "raw.dat"), Buffer.from([65, 0, 66]));
  assert.deepEqual((await listChanges(root, exec, readText)).files, [
    { path: "gone.txt", status: "D", add: 0, del: 2, untracked: false, binary: false },
    { path: "img.bin", status: "M", add: 0, del: 0, untracked: false, binary: true },
    { path: "my dir/a file.txt", status: "A", add: 1, del: 0, untracked: true, binary: false },
    { path: "raw.dat", status: "A", add: 0, del: 0, untracked: true, binary: true },
    { path: "tab\there \"q\" é.txt", status: "A", add: 2, del: 0, untracked: true, binary: false },
  ]);
});

test("listChanges: a merge conflict shows as U", async () => {
  const root = makeRepo({ "c.txt": "base\n" });
  gitIn(root, "checkout", "-q", "-b", "other");
  write(root, "c.txt", "other\n");
  gitIn(root, "commit", "-q", "-am", "other");
  gitIn(root, "checkout", "-q", "main");
  write(root, "c.txt", "main\n");
  gitIn(root, "commit", "-q", "-am", "main");
  try { gitIn(root, "merge", "-q", "other"); } catch { /* the conflict is the point */ }
  const { files } = await listChanges(root, exec, readText);
  assert.deepEqual(files.map((f) => [f.path, f.status]), [["c.txt", "U"]]);
});

test("listChanges: a repo with no commits counts each file's worktree lines as added", async () => {
  const root = makeRepo();
  write(root, "a.txt", "1\n2\n");
  gitIn(root, "add", "a.txt");
  write(root, "a.txt", "1\n2\n3\n");
  write(root, "b.txt", "x\n");
  write(root, "c.txt", "1\n2\n3\n");
  gitIn(root, "add", "c.txt");
  write(root, "c.txt", "1\n");
  assert.deepEqual(await listChanges(root, exec, readText), {
    cut: false,
    files: [
      { path: "a.txt", status: "A", add: 3, del: 0, untracked: false, binary: false },
      { path: "b.txt", status: "A", add: 1, del: 0, untracked: true, binary: false },
      { path: "c.txt", status: "A", add: 1, del: 0, untracked: false, binary: false },
    ],
  });
});

test("listChanges: a file removed from the index but kept on disk is a deletion", async () => {
  const root = makeRepo({ "a.txt": "1\n2\n" });
  gitIn(root, "rm", "-q", "--cached", "a.txt");
  write(root, "b.txt", "x\n");
  assert.deepEqual((await listChanges(root, exec, readText)).files, [
    { path: "a.txt", status: "D", add: 0, del: 2, untracked: false, binary: false },
    { path: "b.txt", status: "A", add: 1, del: 0, untracked: true, binary: false },
  ]);
});

test("listChanges: an untracked nested repo is not listed as a file", async () => {
  const root = makeRepo({ "keep.txt": "k\n" });
  fs.mkdirSync(path.join(root, "nested"));
  gitIn(path.join(root, "nested"), "init", "-q");
  write(root, "nested/x.txt", "x\n");
  write(root, "y.txt", "y\n");
  assert.deepEqual((await listChanges(root, exec, readText)).files, [
    { path: "y.txt", status: "A", add: 1, del: 0, untracked: true, binary: false },
  ]);
});

test("listChanges: stops at 1000 files and says it was cut", async () => {
  const root = makeRepo({ "keep.txt": "k\n" });
  for (let i = 0; i <= 1000; i++) fs.writeFileSync(path.join(root, `f${String(i).padStart(4, "0")}.txt`), "x\n");
  const { files, cut } = await listChanges(root, exec, readText);
  assert.equal(cut, true);
  assert.equal(files.length, 1000);
  assert.equal(files[0].path, "f0000.txt");
  assert.equal(files[999].path, "f0999.txt");
});

test("fileDiff: a modified file gets old and new line numbers", async () => {
  const root = makeRepo({ "m.txt": "a\nb\nc\n" });
  write(root, "m.txt", "a\nB\nc\nd");
  assert.deepEqual(await fileDiff(root, { path: "m.txt", untracked: false }, exec, readText), {
    cut: false,
    notice: null,
    rows: [
      { kind: "hunk", old: null, new: null, text: "@@ -1,3 +1,4 @@" },
      { kind: "ctx", old: 1, new: 1, text: "a" },
      { kind: "del", old: 2, new: null, text: "b" },
      { kind: "add", old: null, new: 2, text: "B" },
      { kind: "ctx", old: 3, new: 3, text: "c" },
      { kind: "add", old: null, new: 4, text: "d" },
    ],
  });
});

test("fileDiff: shows only the named file, even when its name looks like a pathspec", async () => {
  const root = makeRepo({ "f[1].txt": "a\n", "f1.txt": "x\n", ":foo": "a\n", "foo": "x\n" });
  for (const [rel, content] of [["f[1].txt", "A\n"], ["f1.txt", "X\n"], [":foo", "A\n"], ["foo", "X\n"]]) write(root, rel, content);
  const own = [
    { kind: "hunk", old: null, new: null, text: "@@ -1 +1 @@" },
    { kind: "del", old: 1, new: null, text: "a" },
    { kind: "add", old: null, new: 1, text: "A" },
  ];
  assert.deepEqual((await fileDiff(root, { path: "f[1].txt", untracked: false }, exec, readText)).rows, own);
  assert.deepEqual((await fileDiff(root, { path: ":foo", untracked: false }, exec, readText)).rows, own);
});

test("fileDiff: expands tabs in the hunk header's function context", async () => {
  const root = makeRepo({ "m.c": "int\tmain()\n1\n2\n3\n4\n5\n6\n7\n8\n" });
  write(root, "m.c", "int\tmain()\n1\n2\n3\n4\n5\n6\n7\nEIGHT\n");
  const { rows } = await fileDiff(root, { path: "m.c", untracked: false }, exec, readText);
  assert.equal(rows[0].text, "@@ -6,4 +6,4 @@ int main()");
});

test("fileDiff: an untracked file is all added, numbered from 1", async () => {
  const root = makeRepo({ "keep.txt": "k\n" });
  write(root, "my dir/new file.txt", "x\ny\n");
  assert.deepEqual(await fileDiff(root, { path: "my dir/new file.txt", untracked: true }, exec, readText), {
    cut: false,
    notice: null,
    rows: [
      { kind: "hunk", old: null, new: null, text: "@@ -0,0 +1,2 @@" },
      { kind: "add", old: null, new: 1, text: "x" },
      { kind: "add", old: null, new: 2, text: "y" },
    ],
  });
});

test("fileDiff: a staged file in a repo with no commits is all added", async () => {
  const root = makeRepo();
  write(root, "a.txt", "1\n");
  gitIn(root, "add", "a.txt");
  assert.deepEqual((await fileDiff(root, { path: "a.txt", untracked: false }, exec, readText)).rows, [
    { kind: "hunk", old: null, new: null, text: "@@ -0,0 +1,1 @@" },
    { kind: "add", old: null, new: 1, text: "1" },
  ]);
});

test("fileDiff: a deleted file is all removed", async () => {
  const root = makeRepo({ "d.txt": "p\nq\n" });
  fs.rmSync(path.join(root, "d.txt"));
  assert.deepEqual((await fileDiff(root, { path: "d.txt", untracked: false }, exec, readText)).rows, [
    { kind: "hunk", old: null, new: null, text: "@@ -1,2 +0,0 @@" },
    { kind: "del", old: 1, new: null, text: "p" },
    { kind: "del", old: 2, new: null, text: "q" },
  ]);
});

test("fileDiff: binary files, tracked or not, get a notice", async () => {
  const root = makeRepo({ "img.bin": Buffer.from([0, 1, 2]) });
  fs.writeFileSync(path.join(root, "img.bin"), Buffer.from([0, 7]));
  fs.writeFileSync(path.join(root, "new.bin"), Buffer.from([1, 0]));
  const notice = { rows: [], cut: false, notice: "Binary file · no text diff" };
  assert.deepEqual(await fileDiff(root, { path: "img.bin", untracked: false }, exec, readText), notice);
  assert.deepEqual(await fileDiff(root, { path: "new.bin", untracked: true }, exec, readText), notice);
  assert.deepEqual(await fileDiff(root, { path: "unreadable", untracked: true }, exec, async () => null), notice);
});

test("fileDiff: expands tabs, cuts long lines, skips the no-newline marker", async () => {
  const root = makeRepo({ "t.txt": "old" });
  write(root, "t.txt", `\tx\nab\tc\n${"z".repeat(5000)}`);
  const { rows } = await fileDiff(root, { path: "t.txt", untracked: false }, exec, readText);
  assert.deepEqual(rows.map((r) => r.kind), ["hunk", "del", "add", "add", "add"]);
  assert.equal(rows[2].text, "    x");
  assert.equal(rows[3].text, "ab  c");
  assert.equal(rows[4].text, "z".repeat(3999) + "…");
});

test("fileDiff: stops at 1500 rows and says it was cut", async () => {
  const root = makeRepo({ "keep.txt": "k\n" });
  const big = Array.from({ length: 2000 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
  write(root, "big.txt", big);
  const untracked = await fileDiff(root, { path: "big.txt", untracked: true }, exec, readText);
  assert.equal(untracked.cut, true);
  assert.equal(untracked.rows.length, 1500);
  assert.deepEqual(untracked.rows[0], { kind: "hunk", old: null, new: null, text: "@@ -0,0 +1,2000 @@" });
  assert.deepEqual(untracked.rows[1499], { kind: "add", old: null, new: 1499, text: "l1499" });
  gitIn(root, "add", "big.txt");
  gitIn(root, "commit", "-q", "-m", "big");
  fs.rmSync(path.join(root, "big.txt"));
  const tracked = await fileDiff(root, { path: "big.txt", untracked: false }, exec, readText);
  assert.equal(tracked.cut, true);
  assert.equal(tracked.rows.length, 1500);
  assert.deepEqual(tracked.rows[1499], { kind: "del", old: 1499, new: null, text: "l1499" });
});

test("reading a repo leaves its index and status unchanged", async () => {
  const root = makeRepo({ "a.txt": "a\n", "b.txt": "b\n" });
  write(root, "a.txt", "A\n");
  write(root, "c.txt", "c\n");
  // Same content, new mtime: a plain `git status` or `git diff` would refresh and rewrite the index.
  const later = new Date(Date.now() + 60_000);
  fs.utimesSync(path.join(root, "b.txt"), later, later);
  const index = path.join(root, ".git", "index");
  const status = () => gitIn(root, ...READ, "status", "--porcelain");
  const before = { bytes: fs.readFileSync(index), mtime: fs.statSync(index).mtimeMs, status: status() };

  const { files } = await listChanges(root, exec, readText);
  for (const file of files) await fileDiff(root, file, exec, readText);
  await fileDiff(root, { path: "b.txt", untracked: false }, exec, readText);

  assert.deepEqual(fs.readFileSync(index), before.bytes);
  assert.equal(fs.statSync(index).mtimeMs, before.mtime);
  assert.equal(status(), before.status);
  assert.equal(fs.existsSync(path.join(root, ".git", "index.lock")), false);
});

// The app cuts a script slice off at 500 ms; a tab-expanding regex that rescans each line
// from every position took that long on a few hundred long lines without tabs.
test("fileDiff: long lines without tabs are read in linear time", async () => {
  const line = "x".repeat(3999);
  const root = makeRepo({ "min.js": `${line}a\n`.repeat(300) });
  write(root, "min.js", `${line}b\n`.repeat(300));
  const started = Date.now();
  const { rows } = await fileDiff(root, { path: "min.js", untracked: false }, exec, readText);
  assert.equal(rows.length, 601);
  assert.ok(Date.now() - started < 1500, `took ${Date.now() - started} ms`);
});

// The app rejects a mod's host call once 1024 are outstanding, so file reads must not all start at once.
test("listChanges keeps its outstanding file reads well under the app's host call limit", async () => {
  const root = makeRepo({ "seed.txt": "x\n" });
  for (let i = 0; i < 1100; i++) write(root, `many/f${i}.txt`, `${i}\n`);
  let open = 0, most = 0;
  const limitedRead = async (p) => {
    if (++open > 100) throw new Error("too many outstanding host calls");
    most = Math.max(most, open);
    try { return await readText(p); } finally { open--; }
  };
  const { files, cut } = await listChanges(root, exec, limitedRead);
  assert.equal(files.length, 1000);
  assert.equal(cut, true);
  assert.ok(most <= 100, `peak ${most}`);
});
