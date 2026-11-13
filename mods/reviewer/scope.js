import { resolveFolder, listChanges } from "./git.js";

export const MAX_FOLDERS = 10;

// The one place that decides which repos and files the reviewer shows.
export async function collectScope(folders, exec, readText) {
  const resolved = await Promise.all(folders.slice(0, MAX_FOLDERS).map((folder) => resolveFolder(folder, exec)));
  const roots = [...new Set(resolved.filter((f) => f.state === "repo").map((f) => f.root))];
  const repos = await Promise.all(roots.map(async (root) => ({ root, ...(await listChanges(root, exec, readText)) })));
  return { folders: resolved, cutFolders: folders.length > MAX_FOLDERS, repos: repos.filter((r) => r.files.length) };
}
