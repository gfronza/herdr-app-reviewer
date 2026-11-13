import { resolveFolder, listChanges } from "./git.js";
import { branchRange, commitsRange } from "./revs.js";

export const MAX_FOLDERS = 10;

/**
 * uncommitted: every change not yet committed. branch: everything since HEAD left its base,
 * per repo, with picked bases keyed by repo root. commits: one commit or a run, in one repo.
 * @typedef {{ kind: "uncommitted" }
 *   | { kind: "branch", bases: Record<string, string> }
 *   | { kind: "commits", root: string, first: string, last: string }} Scope
 */

// The one place that decides which repos and files the reviewer shows.
/** @param {Scope} scope */
export async function collectScope(folders, scope, exec, readText) {
  const resolved = await Promise.all(folders.slice(0, MAX_FOLDERS).map((folder) => resolveFolder(folder, exec)));
  const roots = [...new Set(resolved.filter((f) => f.state === "repo").map((f) => f.root))]
    .filter((root) => scope.kind !== "commits" || root === scope.root);
  const repos = await Promise.all(roots.map((root) => repoIn(root, scope, exec, readText)));
  // A branch or commits repo stays listed with nothing in it, to show its base or its problem.
  return { folders: resolved, repos: repos.filter((r) => r.files.length || scope.kind !== "uncommitted") };
}

const NONE = { files: [], cut: false };

/** @param {Scope} scope */
async function repoIn(root, scope, exec, readText) {
  if (scope.kind === "branch") {
    const { base, missing, range, problem } = await branchRange(root, scope.bases[root], exec);
    const changes = range ? await listChanges(root, exec, readText, range) : NONE;
    return { root, range, label: base && `branch vs ${base}`, base, missing, problem, ...changes };
  }
  if (scope.kind === "commits") {
    const range = await commitsRange(root, scope.first, scope.last, exec);
    const label = scope.first === scope.last ? `commit ${scope.first.slice(0, 7)}` : `commits ${scope.first.slice(0, 7)} to ${scope.last.slice(0, 7)}`;
    const changes = range ? await listChanges(root, exec, readText, range) : NONE;
    return { root, range, label, base: null, missing: null, problem: range ? null : "those commits are gone: press G to pick again", ...changes };
  }
  return { root, range: null, label: null, base: null, missing: null, problem: null, ...(await listChanges(root, exec, readText)) };
}
