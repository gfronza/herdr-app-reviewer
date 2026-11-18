import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { knownFolders, knownRows, namesIn, parseTyped, pathRows, remember, reposIn, tilde } from "../mods/reviewer/folders.js";

const HOME = "/Users/me";

test("parseTyped: a path splits into the folder to list and the start of the name", () => {
  assert.deepEqual(parseTyped("/usr/lo", HOME), { dir: "/usr", prefix: "lo", typed: "/usr/" });
  assert.deepEqual(parseTyped("/usr/", HOME), { dir: "/usr", prefix: "", typed: "/usr/" });
  assert.deepEqual(parseTyped("/", HOME), { dir: "/", prefix: "", typed: "/" });
  assert.deepEqual(parseTyped("/us", HOME), { dir: "/", prefix: "us", typed: "/" });
  assert.deepEqual(parseTyped("/usr//lo", HOME), { dir: "/usr", prefix: "lo", typed: "/usr//" });
});

test("parseTyped: ~ is the home folder, kept as typed for completion", () => {
  assert.deepEqual(parseTyped("~/Code/her", HOME), { dir: "/Users/me/Code", prefix: "her", typed: "~/Code/" });
  assert.deepEqual(parseTyped("~/", HOME), { dir: "/Users/me", prefix: "", typed: "~/" });
  assert.deepEqual(parseTyped("~", HOME), { dir: "/Users", prefix: "me", typed: "/Users/" });
});

test("parseTyped: anything else is lowercase words", () => {
  assert.deepEqual(parseTyped("Herdr  back", HOME), { terms: ["herdr", "back"] });
  assert.deepEqual(parseTyped("~other/x", HOME), { terms: ["~other/x"] });
  assert.deepEqual(parseTyped("", HOME), { terms: [] });
});

test("namesIn and reposIn: read what find prints for subfolders and for repos among them", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "reviewer-folders-")));
  for (const d of ["app", "lib/.git", ".cache", "worktree", "real"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "worktree/.git"), "gitdir: elsewhere\n");
  writeFileSync(join(dir, "notes.txt"), "");
  symlinkSync(join(dir, "real"), join(dir, "linked"));
  symlinkSync(join(dir, "gone"), join(dir, "broken"));
  const find = (...args) => execFileSync("find", ["-L", dir, ...args], { encoding: "utf8" });
  assert.deepEqual(namesIn(find("-mindepth", "1", "-maxdepth", "1", "-type", "d")).sort(), [".cache", "app", "lib", "linked", "real", "worktree"]);
  assert.deepEqual(reposIn(find("-mindepth", "2", "-maxdepth", "2", "-name", ".git")).sort(), ["lib", "worktree"]);
});

test("pathRows: the folder itself, then its subfolders by name, hidden ones left out", () => {
  const rows = pathRows({ dir: "/w", prefix: "" }, ["b", ".git", "a"], new Set(["b"]));
  assert.deepEqual(rows, [{ path: "/w", use: true }, { path: "/w/a", name: "a", repo: false }, { path: "/w/b", name: "b", repo: true }]);
});

test("pathRows: a prefix keeps the names starting with it, any case, the exact name first", () => {
  const rows = pathRows({ dir: "/w", prefix: "app" }, ["apps", "App2", "app", "myapp"], new Set());
  assert.deepEqual(rows.map((r) => r.name), ["app", "App2", "apps"]);
});

test("pathRows: a prefix starting with a dot shows hidden folders; under / paths have one slash", () => {
  assert.deepEqual(pathRows({ dir: "/", prefix: ".c" }, [".cache", "cfg", ".config"], new Set()).map((r) => r.path), ["/.cache", "/.config"]);
});

test("knownFolders: this tab's terminals, then others, then recent picks, each once, skipping some", () => {
  const panes = [
    { tab: "t2", cwd: "/other" }, { tab: "t1", cwd: "/mine" }, { tab: "t1", cwd: null },
    { tab: "t2", cwd: "/mine" }, { tab: "t1", cwd: "/base" },
  ];
  assert.deepEqual(knownFolders(panes, "t1", ["/old", "/other"], new Set(["/base"])),
    [{ path: "/mine", recent: false }, { path: "/other", recent: false }, { path: "/old", recent: true }]);
});

test("knownRows: every word must be in the path as shown, with ~ for home", () => {
  const folders = [{ path: "/Users/me/Code/herdr-app" }, { path: "/Users/me/Code/other" }, { path: "/tmp/herdr" }];
  assert.deepEqual(knownRows(folders, ["~/code", "herdr"], HOME).map((f) => f.path), ["/Users/me/Code/herdr-app"]);
  assert.equal(knownRows(folders, [], HOME).length, 3);
});

test("tilde: home and paths under it start with ~; others and look-alikes stay", () => {
  assert.deepEqual(["/Users/me", "/Users/me/x", "/Users/meg", "/tmp"].map((p) => tilde(p, HOME)), ["~", "~/x", "/Users/meg", "/tmp"]);
});

test("remember: the folder moves to the front, at most ten kept", () => {
  assert.deepEqual(remember(["/a", "/b", "/c"], "/b"), ["/b", "/a", "/c"]);
  assert.equal(remember(Array.from({ length: 10 }, (_, i) => `/${i}`), "/new").length, 10);
});
