// The reviewer's settings: what each offers, its default, and where it is kept. Four predate the
// settings screen and keep their own shared keys, which their keys and header buttons also toggle;
// the rest share SETTINGS_KEY, which holds only the values that differ from the default. `group`
// says when a change shows: "view" and "limits" in open panes, "start" only in panes opened after it.
export const SETTINGS_KEY = "reviewer.settings";

/** @typedef {{ key: string, title: string, description: string, choices: Record<string, string>, default: string, group: "view" | "start" | "limits", store?: string }} Option */

/** @type {Option[]} */
export const OPTIONS = [
  { key: "layout", group: "view", store: "reviewer.layout", title: "Layout", description: "The file list above the diff, or on its right (l)", choices: { stacked: "Stacked", side: "Side by side" }, default: "stacked" },
  { key: "diff", group: "view", store: "reviewer.diff", title: "Diff", description: "Changes in one column, or the old code beside the new (w)", choices: { unified: "One column", split: "Old beside new" }, default: "unified" },
  { key: "show", group: "view", title: "Diff shows", description: "The selected file, or every listed file one after another (a)", choices: { one: "One file", all: "All files" }, default: "one" },
  { key: "files", group: "view", store: "reviewer.files", title: "File list", description: "Files in a folder tree, or a flat list (z)", choices: { tree: "Tree", flat: "Flat" }, default: "tree" },
  { key: "wrap", group: "view", store: "reviewer.wrap", title: "Wrap long lines", description: "Long lines wrap, or run past the pane's edge", choices: { off: "Off", on: "On" }, default: "off" },
  { key: "scope", group: "start", title: "Starting scope", description: "What a new reviewer pane shows first", choices: { uncommitted: "Local", branch: "Branch", turn: "Turn" }, default: "uncommitted" },
  { key: "session", group: "start", title: "This session at start", description: "A new pane shows only the files this session's turns changed (o)", choices: { off: "Off", on: "On" }, default: "off" },
  { key: "markdown", group: "start", title: "Markdown at start", description: "A new pane shows Markdown files as a diff, or rendered (m)", choices: { diff: "Diff", rendered: "Rendered" }, default: "diff" },
  { key: "refresh", group: "limits", title: "Refresh", description: "How often the changes are read again, besides on every file change", choices: { "5": "5 s", "10": "10 s", "30": "30 s", "60": "1 min" }, default: "10" },
  // No higher: the file list draws every row, and past about 1,000 a draw can run out of time.
  { key: "fileLimit", group: "limits", title: "Files shown", description: "The most changed files listed per repo", choices: { "250": "250", "500": "500", "1000": "1,000" }, default: "1000" },
  { key: "diffLines", group: "limits", title: "Diff lines", description: "The most lines a diff shows", choices: { "1500": "1,500", "3000": "3,000", "5000": "5,000" }, default: "1500" },
  { key: "lineLength", group: "limits", title: "Line length", description: "Longer lines are cut at this many characters", choices: { "1000": "1,000", "4000": "4,000", "10000": "10,000" }, default: "4000" },
  { key: "commits", group: "limits", title: "Commits to pick from", description: "How many recent commits the commit picker lists (G)", choices: { "50": "50", "100": "100", "200": "200" }, default: "100" },
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
 * The setting's value as its choice reads, such as "1,500".
 * @param {string} key
 * @param {(sharedKey: string) => unknown} read
 */
export function labelOf(key, read) {
  return optionFor(key).choices[valueOf(key, read)];
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
