import { test } from "node:test";
import assert from "node:assert/strict";
import { headEntry, pruneHeads } from "../mods/reviewer/head.js";

const state = (over = {}) => ({ base: "/r/app", unsent: 0, view: "changes", scope: "uncommitted", sessionOnly: false, sideBySide: false, ...over });
// One string per control: its command, then * when selected and | when it starts a group.
const show = (entry) => entry.actions.map((a) => `${a.gap ? "| " : ""}${a.command.replace("reviewer.", "")}${a.selected ? "*" : ""}`);

test("headEntry: the changes view shows the scopes, the toggles and Folders, with the scope selected", () => {
  const entry = headEntry(state({ scope: "branch" }));
  assert.equal(entry.title, "Reviewer");
  assert.equal(entry.detail, "/r/app");
  assert.equal(entry.badge, undefined);
  assert.deepEqual(show(entry), ["scope-uncommitted", "scope-branch*", "scope-turn", "scope-commits", "| session-only", "layout", "folders"]);
  assert.deepEqual(entry.actions.slice(0, 4).map((a) => a.label), ["Local", "Branch", "Turn", "Commits"]);
});

test("headEntry: This session and side by side show as selected toggles", () => {
  assert.deepEqual(show(headEntry(state({ scope: "turn", sessionOnly: true, sideBySide: true }))),
    ["scope-uncommitted", "scope-branch", "scope-turn*", "scope-commits", "| session-only*", "layout*", "folders"]);
});

test("headEntry: the folders view shows only the way back, selected", () => {
  const entry = headEntry(state({ view: "folders" }));
  assert.deepEqual(show(entry), ["folders*"]);
  assert.equal(entry.actions[0].tooltip, "Back to the changes");
});

test("headEntry: unsent comments show as a badge, and no folder says so", () => {
  const entry = headEntry(state({ base: null, unsent: 2 }));
  assert.equal(entry.badge, "2 unsent");
  assert.equal(entry.detail, "No folder");
});

test("pruneHeads: keeps live panes, whoever wrote them, and drops closed ones", () => {
  const heads = { p1: { title: "Reviewer" }, p2: { title: "diff.js" }, gone: { title: "Reviewer" } };
  assert.deepEqual(pruneHeads(heads, new Set(["p1", "p2", "p3"])), { p1: { title: "Reviewer" }, p2: { title: "diff.js" } });
});
