import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { READ } from "../mods/reviewer/git.js";
import { MAX_FOLDERS, collectScope } from "../mods/reviewer/scope.js";

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
const tmp = (prefix) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));

const UNCOMMITTED = { kind: "uncommitted" };
const head = (dir) => gitIn(dir, "rev-parse", "HEAD").trim();

function makeRepo() {
  const dir = tmp("reviewer-scope-");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.txt"), "a\n");
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "add", "-A");
  gitIn(dir, "commit", "-q", "-m", "init");
  return dir;
}

test("collectScope: folders in order, one group per repo, clean repos omitted", async () => {
  const changed = makeRepo(), clean = makeRepo(), home = tmp("reviewer-home-");
  fs.writeFileSync(path.join(changed, "src", "a.txt"), "a\nb\n");
  const gone = path.join(home, "gone");
  const scope = await collectScope([home, changed, clean, path.join(changed, "src"), gone], UNCOMMITTED, exec, readText);
  assert.deepEqual(scope, {
    folders: [
      { folder: home, state: "not-repo" },
      { folder: changed, state: "repo", root: changed },
      { folder: clean, state: "repo", root: clean },
      { folder: path.join(changed, "src"), state: "repo", root: changed },
      { folder: gone, state: "missing" },
    ],
    repos: [{ root: changed, range: null, label: null, base: null, missing: null, problem: null, cut: false, files: [{ path: "src/a.txt", status: "M", add: 1, del: 0, untracked: false, binary: false }] }],
  });
});

test("collectScope: a subfolder alone stands for its whole repo", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "top.txt"), "t\n");
  const { repos } = await collectScope([path.join(repo, "src")], UNCOMMITTED, exec, readText);
  assert.deepEqual(repos.map((r) => [r.root, r.files.map((f) => f.path)]), [[repo, ["top.txt"]]]);
});

test("collectScope: reads only the first MAX_FOLDERS folders", async () => {
  const home = tmp("reviewer-many-");
  const folders = Array.from({ length: MAX_FOLDERS + 1 }, (_, i) => path.join(home, `missing-${i}`));
  const scope = await collectScope(folders, UNCOMMITTED, exec, readText);
  assert.equal(MAX_FOLDERS, 10);
  assert.deepEqual(scope.folders.map((f) => f.folder), folders.slice(0, 10));
  assert.deepEqual(scope.repos, []);
});

test("collectScope leaves the index and status unchanged", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "src", "a.txt"), "changed\n");
  const index = path.join(repo, ".git", "index");
  const status = () => gitIn(repo, ...READ, "status", "--porcelain");
  const before = { bytes: fs.readFileSync(index), mtime: fs.statSync(index).mtimeMs, status: status() };
  await collectScope([repo, path.join(repo, "src")], UNCOMMITTED, exec, readText);
  assert.deepEqual(fs.readFileSync(index), before.bytes);
  assert.equal(fs.statSync(index).mtimeMs, before.mtime);
  assert.equal(status(), before.status);
});

test("collectScope, branch: each repo diffs from where it left its base, clean ones listed too", async () => {
  const work = makeRepo(), clean = makeRepo();
  const base = head(work);
  gitIn(work, "checkout", "-q", "-b", "feature");
  fs.writeFileSync(path.join(work, "src", "b.txt"), "b\n");
  gitIn(work, "add", "-A");
  gitIn(work, "commit", "-q", "-m", "b");
  fs.writeFileSync(path.join(work, "src", "a.txt"), "a\nedit\n");
  const { repos } = await collectScope([work, clean], { kind: "branch", bases: {} }, exec, readText);
  assert.deepEqual(repos.map((r) => ({ root: r.root, label: r.label, from: r.range?.from, files: r.files.map((f) => f.path) })), [
    { root: work, label: "branch vs main", from: base, files: ["src/a.txt", "src/b.txt"] },
    { root: clean, label: "branch vs main", from: head(clean), files: [] },
  ]);
});

test("collectScope, branch: a picked base replaces the default", async () => {
  const repo = makeRepo();
  fs.writeFileSync(path.join(repo, "src", "b.txt"), "b\n");
  gitIn(repo, "add", "-A");
  gitIn(repo, "commit", "-q", "-m", "b");
  const { repos } = await collectScope([repo], { kind: "branch", bases: { [repo]: "HEAD~1" } }, exec, readText);
  assert.deepEqual([repos[0].label, repos[0].files.map((f) => f.path)], ["branch vs HEAD~1", ["src/b.txt"]]);
});

test("collectScope, commits: only the picked repo, only the picked run", async () => {
  const repo = makeRepo(), other = makeRepo();
  fs.writeFileSync(path.join(other, "src", "a.txt"), "changed\n");
  const commit = (name) => {
    fs.writeFileSync(path.join(repo, "src", name), `${name}\n`);
    gitIn(repo, "add", "-A");
    gitIn(repo, "commit", "-q", "-m", name);
    return head(repo);
  };
  const first = commit("b.txt"), last = commit("c.txt");
  commit("d.txt");
  fs.writeFileSync(path.join(repo, "src", "e.txt"), "uncommitted\n");
  const { repos } = await collectScope([repo, other], { kind: "commits", root: repo, first, last }, exec, readText);
  assert.deepEqual(repos.map((r) => [r.root, r.label, r.files.map((f) => f.path)]),
    [[repo, `commits ${first.slice(0, 7)} to ${last.slice(0, 7)}`, ["src/b.txt", "src/c.txt"]]]);
});

test("collectScope, commits: a pick that no longer resolves says so", async () => {
  const repo = makeRepo();
  const gone = "0".repeat(40);
  const { repos } = await collectScope([repo], { kind: "commits", root: repo, first: gone, last: gone }, exec, readText);
  assert.deepEqual([repos[0].files, repos[0].problem], [[], "those commits are gone: press G to pick again"]);
});
