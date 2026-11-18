// The typed folder picker: what the typed text points at, and the folders it lists.

const RECENT = 10;

/** `path` with the home folder written as `~`. */
export const tilde = (path, home) => (path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path);

/**
 * Text starting with `/`, `~/` or `~` alone is a path: the folder to list, the start of the names
 * to keep, and the text as typed up to its last `/`, which completion builds on. Anything else is
 * words that filter the known folders.
 * @returns {{ dir: string, prefix: string, typed: string } | { terms: string[] }}
 */
export function parseTyped(text, home) {
  if (!text.startsWith("/") && text !== "~" && !text.startsWith("~/")) return { terms: text.toLowerCase().split(/\s+/).filter(Boolean) };
  const path = (text.startsWith("~") ? home + text.slice(1) : text).replace(/\/{2,}/g, "/");
  const cut = path.lastIndexOf("/"), typedCut = text.lastIndexOf("/");
  // Only `~` alone has no `/` to keep: completion builds on its expansion's.
  return { dir: path.slice(0, cut) || "/", prefix: path.slice(cut + 1), typed: typedCut < 0 ? path.slice(0, cut + 1) : text.slice(0, typedCut + 1) };
}

/** Folder names from the output of `find <dir> -mindepth 1 -maxdepth 1`, and of `-mindepth 2 -maxdepth 2 -name .git`. */
export const namesIn = (stdout) => stdout.split("\n").filter(Boolean).map((line) => line.split("/").pop());
export const reposIn = (stdout) => stdout.split("\n").filter(Boolean).map((line) => line.split("/").at(-2));

/**
 * The rows for a path: with nothing after the last `/`, the folder itself first; then its
 * subfolders whose names start with the prefix, any case, the exact name first. Hidden folders
 * show only once the prefix starts with a dot.
 * @param {{ dir: string, prefix: string }} at @param {string[]} names @param {Set<string>} repos
 */
export function pathRows(at, names, repos) {
  const p = at.prefix.toLowerCase(), join = (name) => (at.dir === "/" ? `/${name}` : `${at.dir}/${name}`);
  const kept = names.filter((n) => n.toLowerCase().startsWith(p) && (p.startsWith(".") || !n.startsWith(".")))
    .sort((a, b) => Number(b === at.prefix) - Number(a === at.prefix) || a.localeCompare(b));
  return [...(at.prefix ? [] : [{ path: at.dir, use: true }]), ...kept.map((name) => ({ path: join(name), name, repo: repos.has(name) }))];
}

/**
 * Folders Herdr already knows, each once: this tab's terminals first, then the other terminals,
 * then folders picked before. `skip` are the ones not to offer.
 * @param {{ tab: string, cwd: string | null }[]} panes @param {string[]} recent @param {Set<string>} skip
 */
export function knownFolders(panes, tab, recent, skip) {
  const terminals = (mine) => panes.filter((p) => p.cwd && (p.tab === tab) === mine).map((p) => p.cwd);
  return [...new Set([...terminals(true), ...terminals(false), ...recent])].filter((f) => !skip.has(f))
    .map((path) => ({ path, recent: !panes.some((p) => p.cwd === path) }));
}

/** The known folders whose path, as shown, holds every word. */
export const knownRows = (folders, terms, home) => folders.filter((f) => terms.every((t) => tilde(f.path, home).toLowerCase().includes(t)));

/** The recent list with `folder` first. */
export const remember = (recent, folder) => [folder, ...recent.filter((f) => f !== folder)].slice(0, RECENT);
