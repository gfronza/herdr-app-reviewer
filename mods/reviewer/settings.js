// The reviewer's settings: what each offers, its default, and where it is kept. Four predate the
// settings screen and keep their own shared keys, which their keys and header buttons also toggle;
// the rest share SETTINGS_KEY, which holds only the values that differ from the default. `start`
// marks a setting a pane reads when it opens, so a change reaches only panes opened after it.
export const SETTINGS_KEY = "reviewer.settings";

/** @typedef {{ key: string, title: string, description: string, choices: Record<string, string>, default: string, store?: string, start?: boolean }} Option */

/** @type {Option[]} */
export const OPTIONS = [
  { key: "layout", store: "reviewer.layout", title: "Layout", description: "The file list above the diff, or on its right (l)", choices: { stacked: "Stacked", side: "Side by side" }, default: "stacked" },
  { key: "diff", store: "reviewer.diff", title: "Diff", description: "Changes in one column, or the old code beside the new (w)", choices: { unified: "One column", split: "Old beside new" }, default: "unified" },
  { key: "files", store: "reviewer.files", title: "File list", description: "Files in a folder tree, or a flat list (z)", choices: { tree: "Tree", flat: "Flat" }, default: "tree" },
  { key: "wrap", store: "reviewer.wrap", title: "Wrap long lines", description: "Long lines wrap, or run past the pane's edge", choices: { off: "Off", on: "On" }, default: "off" },
  { key: "scope", start: true, title: "Starting scope", description: "What a new reviewer pane shows first", choices: { uncommitted: "Local", branch: "Branch", turn: "Turn" }, default: "uncommitted" },
  { key: "session", start: true, title: "This session at start", description: "A new pane shows only the files this session's turns changed (o)", choices: { off: "Off", on: "On" }, default: "off" },
  { key: "markdown", start: true, title: "Markdown at start", description: "A new pane shows Markdown files as a diff, or rendered (m)", choices: { diff: "Diff", rendered: "Rendered" }, default: "diff" },
];

const optionFor = (/** @type {string} */ key) => /** @type {Option} */ (OPTIONS.find((o) => o.key === key));

/**
 * The setting's value: the stored one when it is still a choice, else the default.
 * @param {string} key
 * @param {(sharedKey: string) => unknown} read
 */
export function valueOf(key, read) {
  const option = optionFor(key);
  const stored = option.store ? read(option.store) : /** @type {Record<string, unknown>} */ (read(SETTINGS_KEY) ?? {})[key];
  return typeof stored === "string" && stored in option.choices ? stored : option.default;
}

/**
 * The shared key and value that save `value` for the setting.
 * @param {string} key
 * @param {string} value
 * @param {(sharedKey: string) => unknown} read
 * @returns {[string, unknown]}
 */
export function writeOf(key, value, read) {
  const option = optionFor(key);
  if (option.store) return [option.store, value];
  const { [key]: _, ...rest } = /** @type {Record<string, unknown>} */ (read(SETTINGS_KEY) ?? {});
  return [SETTINGS_KEY, value === option.default ? rest : { ...rest, [key]: value }];
}
