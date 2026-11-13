import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { branchRange, commitOf, commitsRange, defaultBase, listBranches, listCommits, orderRun } from "../mods/reviewer/revs.js";

// Keep the user's git config (signing, hooks, init.defaultBranch) out of the fixtures.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_NOSYSTEM = "1";

const exec = (cmd, args, { cwd }) => new Promise((resolve) => {
  execFile(cmd, args, { cwd }, (err, stdout, stderr) => {
    resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
  });
});
const gitIn = (dir, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
const head = (dir, rev = "HEAD") => gitIn(dir, "rev-parse", rev).trim();
const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-revs-")));

function makeRepo(branch = "main") {
  const dir = tmp();
  gitIn(dir, "init", "-q", "-b", branch);
  commit(dir, "init");
  return dir;
}

let clock = 1_700_000_000;
// Each commit a minute later, so "most recent first" is not decided by ties.
function commit(dir, name) {
  fs.writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
  gitIn(dir, "add", "-A");
  clock += 60;
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", name], {
    cwd: dir, env: { ...process.env, GIT_AUTHOR_DATE: `${clock} +0000`, GIT_COMMITTER_DATE: `${clock} +0000` },
  });
  return head(dir);
}

test("defaultBase: the local branch origin/HEAD names comes first, not the remote one", async () => {
  const origin = makeRepo("trunk");
  const clone = tmp();
  execFileSync("git", ["clone", "-q", origin, clone]);
  gitIn(clone, "branch", "-q", "main");
  assert.equal(await defaultBase(clone, exec), "trunk");
});

test("defaultBase: with no local copy of origin/HEAD's branch, falls back to main", async () => {
  const origin = makeRepo("trunk");
  gitIn(origin, "branch", "-q", "main");
  const clone = tmp();
  execFileSync("git", ["clone", "-q", "-b", "main", origin, clone]);
  assert.equal(await defaultBase(clone, exec), "main");
});

test("defaultBase: a tag named main is not a branch", async () => {
  const repo = makeRepo("other");
  gitIn(repo, "tag", "main");
  assert.equal(await defaultBase(repo, exec), null);
});

test("defaultBase: then init.defaultBranch, then main, then master", async () => {
  const configured = makeRepo("dev");
  gitIn(configured, "branch", "-q", "main");
  gitIn(configured, "config", "init.defaultBranch", "dev");
  assert.equal(await defaultBase(configured, exec), "dev");
  const both = makeRepo("main");
  gitIn(both, "branch", "-q", "master");
  assert.equal(await defaultBase(both, exec), "main");
  assert.equal(await defaultBase(makeRepo("master"), exec), "master");
  assert.equal(await defaultBase(makeRepo("other"), exec), null);
});

test("commitOf: resolves revisions, refuses option-like text and unknown names", async () => {
  const repo = makeRepo();
  const first = head(repo);
  commit(repo, "two");
  assert.equal(await commitOf(repo, "HEAD~1", exec), first);
  assert.equal(await commitOf(repo, "--all", exec), null);
  assert.equal(await commitOf(repo, "nope", exec), null);
  assert.equal(await commitOf(repo, "", exec), null);
});

test("branchRange: from the merge-base with the default base to the working tree", async () => {
  const repo = makeRepo();
  const fork = commit(repo, "shared");
  gitIn(repo, "checkout", "-q", "-b", "feature");
  commit(repo, "mine");
  gitIn(repo, "checkout", "-q", "main");
  commit(repo, "theirs");
  gitIn(repo, "checkout", "-q", "feature");
  assert.deepEqual(await branchRange(repo, undefined, exec),
    { base: "main", missing: null, range: { from: fork, to: null }, problem: null });
});

test("branchRange: a pick that no longer resolves falls back to the default and is named", async () => {
  const repo = makeRepo();
  const { base, missing } = await branchRange(repo, "deleted-branch", exec);
  assert.deepEqual({ base, missing }, { base: "main", missing: "deleted-branch" });
});

test("branchRange: no base, no commits, and unrelated history each say why", async () => {
  const noBase = makeRepo("other");
  assert.equal((await branchRange(noBase, undefined, exec)).problem, "no base branch: press B to pick one");
  const empty = tmp();
  gitIn(empty, "init", "-q", "-b", "main");
  assert.equal((await branchRange(empty, undefined, exec)).problem, "no commits yet");
  const unrelated = makeRepo();
  gitIn(unrelated, "checkout", "-q", "--orphan", "fresh");
  commit(unrelated, "alone");
  assert.equal((await branchRange(unrelated, undefined, exec)).problem, "no history shared with main");
});

test("commitsRange: one commit diffs from its parent; a root commit from the empty tree", async () => {
  const repo = makeRepo();
  const root = head(repo);
  const two = commit(repo, "two");
  const three = commit(repo, "three");
  assert.deepEqual(await commitsRange(repo, three, three, exec), { from: two, to: three });
  assert.deepEqual(await commitsRange(repo, two, three, exec), { from: root, to: three });
  assert.deepEqual(await commitsRange(repo, root, root, exec), { from: "4b825dc642cb6eb9a060e54bf8d69288fbee4904", to: root });
  assert.equal(await commitsRange(repo, "0".repeat(40), three, exec), null);
});

test("listBranches: local and remote, newest first, without origin/HEAD", async () => {
  const origin = makeRepo();
  const clone = tmp();
  execFileSync("git", ["clone", "-q", origin, clone]);
  gitIn(clone, "checkout", "-q", "-b", "feature");
  commit(clone, "f");
  assert.deepEqual((await listBranches(clone, exec)).map((b) => b.name), ["feature", "main", "origin/main"]);
});

test("listCommits: HEAD's commits newest first, with subject", async () => {
  const repo = makeRepo();
  const two = commit(repo, "two");
  const commits = await listCommits(repo, exec);
  assert.deepEqual(commits.map((c) => [c.sha, c.subject]), [[two, "two"], [head(repo, "HEAD~1"), "init"]]);
  assert.equal(commits[0].root, repo);
  assert.equal(commits[0].short, two.slice(0, 7));
  const empty = tmp();
  gitIn(empty, "init", "-q");
  assert.deepEqual(await listCommits(empty, exec), []);
});

test("commitsRange: a root commit in a SHA-256 repo diffs from that format's empty tree", async () => {
  const repo = tmp();
  gitIn(repo, "init", "-q", "--object-format=sha256", "-b", "main");
  const root = commit(repo, "only");
  assert.deepEqual(await commitsRange(repo, root, root, exec),
    { from: "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321", to: root });
});

test("orderRun: orders a run by ancestry, not log position, and refuses unrelated ends", async () => {
  const repo = makeRepo();
  gitIn(repo, "checkout", "-q", "-b", "side");
  const side = commit(repo, "side");
  gitIn(repo, "checkout", "-q", "main");
  const later = commit(repo, "later");
  gitIn(repo, "merge", "-q", "--no-edit", "side");
  const merge = head(repo);
  assert.deepEqual(await orderRun(repo, merge, side, exec), [side, merge]);
  assert.deepEqual(await orderRun(repo, later, later, exec), [later, later]);
  assert.equal(await orderRun(repo, side, later, exec), null);
});
