import { test } from "node:test";
import assert from "node:assert/strict";
import { OPTIONS, SETTINGS_KEY, labelOf, valueOf, writeOf } from "../mods/reviewer/settings.js";

// Shared state as a plain object, read the way main.js reads it.
const reader = (state) => (key) => state[key];

test("valueOf: every setting reads its default when nothing is stored", () => {
  const read = reader({});
  assert.deepEqual(Object.fromEntries(OPTIONS.map((o) => [o.key, valueOf(o.key, read)])), {
    layout: "stacked", diff: "unified", files: "tree", wrap: "off", scope: "uncommitted", session: "off", markdown: "diff",
    refresh: "10", fileLimit: "1000", diffLines: "1500", lineLength: "4000", commits: "100",
  });
});

test("valueOf: a setting with its own key reads that key", () => {
  const read = reader({ "reviewer.layout": "side", "reviewer.diff": "split", "reviewer.files": "flat", "reviewer.wrap": "on" });
  assert.deepEqual(["layout", "diff", "files", "wrap"].map((k) => valueOf(k, read)), ["side", "split", "flat", "on"]);
});

test("valueOf: the other settings read their entry in the settings object", () => {
  const read = reader({ [SETTINGS_KEY]: { scope: "branch", session: "on", markdown: "rendered" } });
  assert.deepEqual(["scope", "session", "markdown"].map((k) => valueOf(k, read)), ["branch", "on", "rendered"]);
});

test("valueOf: a stored value that is not a choice reads as the default", () => {
  const read = reader({ "reviewer.layout": "diagonal", [SETTINGS_KEY]: { scope: "commits", session: true } });
  assert.deepEqual(["layout", "scope", "session"].map((k) => valueOf(k, read)), ["stacked", "uncommitted", "off"]);
});

test("labelOf: the chosen value as its choice reads, the default when nothing is stored", () => {
  assert.equal(labelOf("diffLines", reader({ [SETTINGS_KEY]: { diffLines: "3000" } })), "3,000");
  assert.equal(labelOf("fileLimit", reader({})), "1,000");
});

test("writeOf: a setting with its own key writes the value there, the default included", () => {
  const read = reader({ "reviewer.wrap": "on" });
  assert.deepEqual(writeOf("wrap", "off", read), ["reviewer.wrap", "off"]);
  assert.deepEqual(writeOf("layout", "side", read), ["reviewer.layout", "side"]);
});

test("writeOf: the other settings keep the object's other entries, and the default drops the entry", () => {
  const read = reader({ [SETTINGS_KEY]: { scope: "branch" } });
  assert.deepEqual(writeOf("markdown", "rendered", read), [SETTINGS_KEY, { scope: "branch", markdown: "rendered" }]);
  assert.deepEqual(writeOf("scope", "uncommitted", read), [SETTINGS_KEY, {}]);
  assert.deepEqual(writeOf("session", "on", reader({})), [SETTINGS_KEY, { session: "on" }]);
});
