// The file list's rows: a folder tree, or the flat list git gives.

const byName = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

function build(entries) {
  const root = { dirs: new Map(), files: [] };
  for (const entry of entries) {
    const parts = entry.file.path.split("/"), name = parts.pop();
    let node = root;
    for (const part of parts) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
      node = node.dirs.get(part);
    }
    node.files.push([name, entry]);
  }
  return root;
}

const count = (node) => node.files.length + [...node.dirs.values()].reduce((n, d) => n + count(d), 0);

// A folder whose only child is a folder shares its row, so `src/app/` takes one row, not two.
function walk(node, prefix, depth, group, collapsed, out) {
  for (const [first, start] of [...node.dirs].sort(byName)) {
    let name = first, dir = start;
    while (!dir.files.length && dir.dirs.size === 1) {
      const [[next, only]] = dir.dirs;
      name += `/${next}`; dir = only;
    }
    const path = prefix ? `${prefix}/${name}` : name, key = `${group}\0${path}`, closed = collapsed.has(key);
    out.push({ dir: true, key, name, depth, count: count(dir), closed });
    if (!closed) walk(dir, path, depth + 1, group, collapsed, out);
  }
  for (const [name, entry] of node.files.sort(byName)) out.push({ entry, prefix: "", name, depth });
}

/**
 * Rows for one group of listed files, in screen order: in a tree, folders first, then files, each
 * by name; a closed folder's files are left out. Folder keys start with `group`, so the same
 * folder in two repos folds on its own. A flat row's `prefix` is its folder path.
 * @param {{ file: { path: string } }[]} entries @param {Set<string>} collapsed
 */
export function fileRows(entries, tree, group, collapsed) {
  if (!tree) {
    return entries.map((entry) => {
      const { path } = entry.file, cut = path.lastIndexOf("/") + 1;
      return { entry, prefix: path.slice(0, cut), name: path.slice(cut), depth: 0 };
    });
  }
  const out = [];
  walk(build(entries), "", 0, group, collapsed, out);
  return out;
}
