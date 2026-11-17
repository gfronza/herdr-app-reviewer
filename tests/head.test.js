import { test } from "node:test";
import assert from "node:assert/strict";
import { headEntry, headerShowsControls, pruneHeads } from "../mods/reviewer/head.js";

const state = (over = {}) => ({ base: "/r/app", unsent: 0, view: "changes", scope: "uncommitted", sessionOnly: false, allFiles: false, sideBySide: false, wrap: false, ...over });
// One string per control: its command, then * when selected and | when it starts a group.
const show = (entry) => entry.actions.map((a) => `${a.gap ? "| " : ""}${a.command.replace("reviewer.", "")}${a.selected ? "*" : ""}`);

test("headEntry: the changes view shows the scopes, the toggles, Folders and Settings, with the scope selected", () => {
  const entry = headEntry(state({ scope: "branch" }));
  assert.equal(entry.title, "Reviewer");
  assert.equal(entry.detail, "/r/app");
  assert.equal(entry.badge, undefined);
  assert.deepEqual(show(entry), ["scope-uncommitted", "scope-branch*", "scope-turn", "scope-commits", "| session-only", "all-files", "layout", "wrap", "folders", "settings"]);
  assert.deepEqual(entry.actions.slice(0, 4).map((a) => a.label), ["Local", "Branch", "Turn", "Commits"]);
});

test("headEntry: This session, all files, side by side and wrap show as selected toggles", () => {
  assert.deepEqual(show(headEntry(state({ scope: "turn", sessionOnly: true, allFiles: true, sideBySide: true, wrap: true }))),
    ["scope-uncommitted", "scope-branch", "scope-turn*", "scope-commits", "| session-only*", "all-files*", "layout*", "wrap*", "folders", "settings"]);
});

test("headEntry: the folders view shows only the way back, selected, and Settings", () => {
  const entry = headEntry(state({ view: "folders" }));
  assert.deepEqual(show(entry), ["folders*", "settings"]);
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

// A layout shaped like Herdr's: the pane header sits on a tab block a few levels down.
const layoutWith = (header) => ({ type: "row", children: [{ id: "sidebar" }, { type: "column", children: [{ content: { tab: "active", pane: header ? { header } : {} } }] }] });
const tabBlock = (id, mod, extra = {}) => ({ id, type: "block", content: { tab: "active", pane: { header: { content: { mod } } } }, ...extra });
const drawsActions = { "pane-header": { version: 1, draws: ["title", "detail", "actions"] } };

test("headerShowsControls: a registered header that draws actions and always shows draws the controls", () => {
  assert.equal(headerShowsControls(layoutWith({ content: { mod: "pane-header" }, reveal: "always" }), drawsActions, []), true);
  assert.equal(headerShowsControls(layoutWith({ content: { mod: "pane-header" } }), drawsActions, null), true);
});

test("headerShowsControls: a registered header that doesn't draw actions keeps the reviewer's rows, whatever the old list says", () => {
  const titlesOnly = { "pane-header": { version: 1, draws: ["title", "detail"] } };
  assert.equal(headerShowsControls(layoutWith({ content: { mod: "pane-header" } }), titlesOnly, ["pane-header"]), false);
  assert.equal(headerShowsControls(layoutWith({ content: { mod: "pane-header" } }), { "pane-header": { version: 1 } }, []), false);
});

test("headerShowsControls: an unregistered header in the old pane-heads-actions list draws the controls", () => {
  assert.equal(headerShowsControls(layoutWith({ content: { mod: "pane-plus" } }), {}, ["pane-plus"]), true);
  assert.equal(headerShowsControls(layoutWith({ content: { mod: "pane-plus" } }), null, ["pane-plus"]), true);
});

test("headerShowsControls: an unknown mod, a hover header, no header, or nothing registered keeps the reviewer's rows", () => {
  assert.equal(headerShowsControls(layoutWith({ content: { mod: "pane" }, reveal: "always" }), drawsActions, ["pane-plus"]), false);
  assert.equal(headerShowsControls(layoutWith({ content: { mod: "pane-header" }, reveal: "hover" }), drawsActions, []), false);
  assert.equal(headerShowsControls(layoutWith(null), drawsActions, ["pane-plus"]), false);
  assert.equal(headerShowsControls(layoutWith({ content: { mod: "pane-header" } }), null, null), false);
});

test("headerShowsControls: a hidden tab block is skipped, and a stack counts only its shown child", () => {
  const hidden = { type: "row", children: [tabBlock("a", "pane-header", { hidden: true }), tabBlock("b", "pane")] };
  assert.equal(headerShowsControls(hidden, drawsActions, []), false);
  const stack = { type: "stack", active: "b", children: [tabBlock("a", "pane"), tabBlock("b", "pane-header")] };
  assert.equal(headerShowsControls(stack, drawsActions, []), true);
  assert.equal(headerShowsControls({ ...stack, active: "a" }, drawsActions, []), false);
});
