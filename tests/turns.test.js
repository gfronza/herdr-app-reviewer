import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileDiff } from "../mods/reviewer/git.js";
import { collectScope, fileKey } from "../mods/reviewer/scope.js";
import { Turns, createTracker, workState } from "../mods/reviewer/turns.js";

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
const write = (dir, rel, content) => fs.writeFileSync(path.join(dir, rel), content);

function makeRepo(files) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-turn-")));
  gitIn(dir, "init", "-q", "-b", "main");
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "init");
  return dir;
}

// Every file under .git with its size and mtime, to prove snapshots write nothing there.
function gitState(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { const s = fs.statSync(p); out[p] = `${s.size}:${s.mtimeMs}`; }
    }
  };
  walk(path.join(dir, ".git"));
  return out;
}

// Every Turns made here, so their temp folders go when the tests end.
const made = [];
after(() => { for (const t of made) if (t.scratch) fs.rmSync(t.scratch, { recursive: true, force: true }); });
class TestTurns extends Turns {
  constructor(...args) { super(...args); made.push(this); }
}

const turnScope = (turns) => ({ kind: /** @type {const} */ ("turn"), ...turns.last() });
const listed = async (root, turns) => (await collectScope([root], turnScope(turns), exec, readText)).repos[0];
const turnDirs = (turns) => (turns.scratch ? fs.readdirSync(turns.scratch).sort() : []);

test("workState: any working agent works, all idle or done rest, blocked holds", () => {
  assert.equal(workState(["idle", "working", "blocked"]), "working");
  assert.equal(workState(["idle", "done"]), "resting");
  assert.equal(workState([]), "resting");
  assert.equal(workState(["idle", "blocked"]), "held");
});

test("tracker: starts on rest to work, a blocked stretch stays in the turn, ends on rest", () => {
  const observe = createTracker();
  const edges = ["resting", "working", "held", "working", "resting", "resting"].map((s) => observe(s));
  assert.deepEqual(edges, [
    { started: false, ended: false },
    { started: true, ended: false },
    { started: false, ended: false },
    { started: false, ended: false },
    { started: false, ended: true },
    { started: false, ended: false },
  ]);
});

test("tracker: a turn already running when sampling begins never starts", () => {
  const observe = createTracker();
  assert.deepEqual(["working", "resting"].map((s) => observe(s).started), [false, false]);
});

test("last turn: only the turn's own changes, against snapshots that leave .git untouched", async () => {
  const root = makeRepo({ "a.txt": "a\n", "b.txt": "b\n", "r.txt": "r\n" });
  write(root, "a.txt", "a\nbefore\n");
  write(root, "u.txt", "untracked before\n");
  const before = gitState(root);
  const turns = new TestTurns(exec);
  await turns.start([root], Date.now());
  write(root, "a.txt", "a\nbefore\nturn\n");
  write(root, "n.txt", "new\n");
  fs.unlinkSync(path.join(root, "b.txt"));
  write(root, "r.txt", "changed\n");
  write(root, "r.txt", "r\n");
  await turns.refresh();
  assert.deepEqual(gitState(root), before);
  const repo = await listed(root, turns);
  assert.deepEqual(repo.files.map((f) => [f.path, f.status, f.add, f.del]), [["a.txt", "M", 1, 0], ["b.txt", "D", 0, 1], ["n.txt", "A", 1, 0]]);
  const diff = await fileDiff(root, repo.files[0], exec, readText, repo.range);
  assert.deepEqual(diff.rows.filter((r) => r.kind !== "ctx").map((r) => [r.kind, r.text]), [["hunk", "@@ -1,2 +1,3 @@"], ["add", "turn"]]);
  assert.deepEqual(gitState(root), before);
});

test("last turn: a commit made during the turn still shows the turn's change", async () => {
  const root = makeRepo({ "a.txt": "a\n" });
  const turns = new TestTurns(exec);
  await turns.start([root], Date.now());
  write(root, "a.txt", "a\nturn\n");
  gitIn(root, "commit", "-q", "-am", "during the turn");
  await turns.refresh();
  assert.deepEqual((await listed(root, turns)).files.map((f) => [f.path, f.add]), [["a.txt", 1]]);
});

test("last turn: a turn that changes nothing leaves the previous turn and removes its own snapshot", async () => {
  const root = makeRepo({ "a.txt": "a\n" });
  const turns = new TestTurns(exec);
  await turns.start([root], Date.now());
  write(root, "a.txt", "a\none\n");
  await turns.end();
  await turns.start([root], Date.now());
  await turns.end();
  await turns.refresh();
  assert.equal(turns.last().gen, 1);
  assert.deepEqual((await listed(root, turns)).files.map((f) => f.path), ["a.txt"]);
  assert.deepEqual(turnDirs(turns), ["turn-1"]);
});

test("last turn: a newer turn removes the older snapshot unless a comment still reads it", async () => {
  const root = makeRepo({ "a.txt": "a\n" });
  let keep = new Set();
  const turns = new TestTurns(exec, { keep: () => keep });
  const turn = async (text) => {
    await turns.start([root], Date.now());
    write(root, "a.txt", `a\n${text}\n`);
    await turns.end();
  };
  await turn("one");
  await turn("two");
  assert.deepEqual([turns.last().gen, turnDirs(turns)], [2, ["turn-2"]]);
  keep = new Set([2]);
  await turn("three");
  assert.deepEqual(turnDirs(turns), ["turn-2", "turn-3"]);
  keep = new Set();
  await turn("four");
  assert.deepEqual(turnDirs(turns), ["turn-4"]);
});

test("last turn: a write as the turn starts may sit in its baseline, so the turn is marked raced", async () => {
  const root = makeRepo({ "a.txt": "a\n" });
  const now = 10000, a = path.join(root, "a.txt");
  const turns = new TestTurns(exec, { clock: () => now });
  turns.wrote(root, 9000, [a]);
  await turns.start([root], 10000);
  write(root, "a.txt", "a\nturn\n");
  await turns.refresh();
  assert.equal(turns.last().raced, true);
  const repo = await listed(root, turns);
  assert.deepEqual([repo.files, repo.problem], [[], "files changed just as the turn started, so this turn is not shown"]);

  const late = new TestTurns(exec, { clock: () => now });
  await late.start([root], 10000);
  late.wrote(root, 10200, [a]);
  write(root, "a.txt", "a\nlater\n");
  await late.refresh();
  assert.equal(late.last().raced, true);

  const clear = new TestTurns(exec, { clock: () => now });
  clear.wrote(root, 8700, [a]);
  await clear.start([root], 10000);
  clear.wrote(root, 10301, [a]);
  write(root, "a.txt", "a\nclear\n");
  await clear.refresh();
  assert.equal(clear.last().raced, false);
});

test("last turn: writes to ignored files and inside .git do not race a turn", async () => {
  const root = makeRepo({ "a.txt": "a\n", ".gitignore": "dist/\n" });
  const turns = new TestTurns(exec, { clock: () => 10000 });
  turns.wrote(root, 9500, [path.join(root, "dist", "bundle.js"), path.join(root, ".git", "index")]);
  await turns.start([root], 10000);
  write(root, "a.txt", "a\nturn\n");
  await turns.refresh();
  assert.deepEqual([turns.last().raced, (await listed(root, turns)).files.map((f) => f.path)], [false, ["a.txt"]]);
});

test("last turn: an ended turn keeps what it changed; later edits by hand are not its own", async () => {
  const root = makeRepo({ "a.txt": "a\n" });
  const turns = new TestTurns(exec);
  await turns.start([root], Date.now());
  write(root, "a.txt", "a\nturn\n");
  await turns.end();
  write(root, "byhand.txt", "by hand\n");
  await turns.refresh();
  assert.deepEqual((await listed(root, turns)).files.map((f) => f.path), ["a.txt"]);
});

test("tracker: with one agent blocked on a question, another agent's turns still start", () => {
  const observe = createTracker();
  const edges = ["resting", "held", "working", "held", "working", "resting"].map((s) => observe(s));
  assert.deepEqual(edges.map((e) => [e.started, e.ended]), [[false, false], [false, false], [true, false], [false, false], [false, false], [false, true]]);
});

test("session: the files every seen turn changed, not edits made between turns", async () => {
  const root = makeRepo({ "x.txt": "x\n", "y.txt": "y\n", "z.txt": "z\n" });
  const turns = new TestTurns(exec);
  await turns.start([root], Date.now());
  write(root, "x.txt", "x\nturn one\n");
  await turns.end();
  write(root, "y.txt", "y\nby hand\n");
  await turns.start([root], Date.now());
  write(root, "z.txt", "z\nturn two\n");
  await turns.refresh();
  assert.deepEqual([...turns.session().files].sort(), [fileKey(root, "x.txt"), fileKey(root, "z.txt")]);
  const scope = await collectScope([root], { kind: "uncommitted" }, exec, readText, turns.session());
  assert.deepEqual([scope.repos[0].files.map((f) => f.path), [...scope.hidden]], [["x.txt", "z.txt"], [fileKey(root, "y.txt")]]);
});

test("session: a repo no turn could read keeps every file and says why", async () => {
  const split = makeRepo({ "s.txt": "s\n" }), plain = makeRepo({ "p.txt": "p\n" });
  gitIn(split, "update-index", "--split-index");
  const turns = new TestTurns(exec);
  await turns.start([split, plain], Date.now());
  write(split, "s.txt", "s\nturn\n");
  write(plain, "p.txt", "p\nturn\n");
  await turns.end();
  const { repos } = await collectScope([split, plain], { kind: "uncommitted" }, exec, readText, turns.session());
  assert.deepEqual(repos.map((r) => [r.files.map((f) => f.path), r.problem]), [
    [["s.txt"], "showing every file: this session can't be told apart here (git's split index is on in this repo, so it has no turn snapshot)"],
    [["p.txt"], null],
  ]);
});

test("last turn: a repo that can never be read does not let an empty turn replace the last one", async () => {
  const split = makeRepo({ "s.txt": "s\n" }), plain = makeRepo({ "p.txt": "p\n" });
  gitIn(split, "update-index", "--split-index");
  const turns = new TestTurns(exec);
  await turns.start([split, plain], Date.now());
  write(plain, "p.txt", "p\nturn\n");
  await turns.end();
  await turns.start([split, plain], Date.now());
  await turns.end();
  assert.deepEqual([turns.last().gen, (await listed(plain, turns)).files.map((f) => f.path)], [1, ["p.txt"]]);
});

test("last turn: snapshots run no hook and no clean filter, so .git stays untouched", async () => {
  const root = makeRepo({ ".gitattributes": "*.bin filter=mark\n", "a.bin": "x\n" });
  gitIn(root, "config", "filter.mark.clean", 'sh -c "touch .git/CLEAN_RAN; cat"');
  gitIn(root, "config", "filter.mark.required", "true");
  write(root, ".git/hooks/post-index-change", '#!/bin/sh\ntouch "$GIT_DIR/../HOOK_RAN" .git/HOOK_RAN\n');
  fs.chmodSync(path.join(root, ".git/hooks/post-index-change"), 0o755);
  const before = gitState(root);
  const turns = new TestTurns(exec);
  await turns.start([root], Date.now());
  write(root, "a.bin", "x\ny\n");
  await turns.end();
  assert.deepEqual(gitState(root), before);
  assert.deepEqual((await listed(root, turns)).files.map((f) => f.path), ["a.bin"]);
});

test("last turn: a split index turned on mid-turn stops the snapshots instead of touching .git", async () => {
  const root = makeRepo({ "a.txt": "a\n" });
  const turns = new TestTurns(exec);
  await turns.start([root], Date.now());
  write(root, "a.txt", "a\nturn\n");
  gitIn(root, "update-index", "--split-index");
  const before = gitState(root);
  await turns.end();
  assert.deepEqual(gitState(root), before);
  assert.equal((await listed(root, turns)).problem, "no turn snapshot: git's split index is on in this repo, so it has no turn snapshot");
});

test("last turn: works when the temp folder's path holds a colon", async () => {
  const root = makeRepo({ "a.txt": "a\n" });
  const tmpdir = process.env.TMPDIR;
  process.env.TMPDIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-a:b-")));
  try {
    const turns = new TestTurns(exec);
    await turns.start([root], Date.now());
    write(root, "a.txt", "a\nturn\n");
    await turns.end();
    assert.match(turns.scratch, /:/);
    assert.deepEqual((await listed(root, turns)).files.map((f) => f.path), ["a.txt"]);
  } finally { process.env.TMPDIR = tmpdir; }
});

test("last turn: a repo with git's split index gets no snapshot and is left untouched", async () => {
  const root = makeRepo({ "a.txt": "a\n" });
  gitIn(root, "update-index", "--split-index");
  const before = gitState(root);
  const turns = new TestTurns(exec);
  await turns.start([root], Date.now());
  write(root, "a.txt", "a\nturn\n");
  await turns.end();
  assert.deepEqual(gitState(root), before);
  const repo = await listed(root, turns);
  assert.deepEqual([repo.files, repo.problem], [[], "git's split index is on in this repo, so it has no turn snapshot"]);
});

test("a reopened pane clears what the last copy of it left, in the same folder", async () => {
  const root = makeRepo({ "a.txt": "a\n" });
  const name = `test-${process.pid}`;
  const first = new TestTurns(exec, { name });
  await first.start([root], Date.now());
  write(root, "a.txt", "a\nturn\n");
  await first.end();
  assert.deepEqual(turnDirs(first), ["turn-1"]);
  const again = new TestTurns(exec, { name });
  await again.open();
  assert.deepEqual([again.scratch, turnDirs(again)], [first.scratch, []]);
  assert.match(again.scratch, /\/herdr-reviewer-test-\d+$/);
});
