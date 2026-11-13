import { resolveFolder, listChanges } from "./git.js";
import { branchRange, commitsRange } from "./revs.js";

export const MAX_FOLDERS = 10;

export const fileKey = (root, path) => `${root}\0${path}`;

/**
 * uncommitted: every change not yet committed. branch: everything since HEAD left its base,
 * per repo, with picked bases keyed by repo root. commits: one commit or a run, in one repo.
 * turn: the latest agent turn's snapshots (null `gen`: none seen), per repo a range or a problem.
 * @typedef {{ kind: "uncommitted" }
 *   | { kind: "branch", bases: Record<string, string> }
 *   | { kind: "commits", root: string, first: string, last: string }
 *   | { kind: "turn", gen: number | null, raced: boolean, objects: string | null,
 *       repos: Record<string, { from?: string, to?: string, problem?: string }> }} Scope
 */

/** Each watched folder resolved, and the repos they hold, each once. */
export async function resolveRoots(folders, exec) {
  const resolved = await Promise.all(folders.slice(0, MAX_FOLDERS).map((folder) => resolveFolder(folder, exec)));
  return { resolved, roots: [...new Set(resolved.filter((f) => f.state === "repo").map((f) => f.root))] };
}

// The one place that decides which repos and files the reviewer shows. `only`, when given, is the
// "this session only" filter: it keeps the files it holds, except in the repos it cannot judge,
// which keep every file and say why. `hidden` names the files it took out.
/** @param {Scope} scope @param {{ files: Set<string>, blind: Map<string, string> } | null} [only] */
export async function collectScope(folders, scope, exec, readText, only = null) {
  const { resolved, roots } = await resolveRoots(folders, exec);
  const hidden = new Set();
  const repos = (await Promise.all(roots.filter((root) => scope.kind !== "commits" || root === scope.root)
    .map((root) => repoIn(root, scope, exec, readText))))
    .map((r) => {
      if (!only) return r;
      if (only.blind.has(r.root)) return { ...r, problem: r.problem ?? `showing every file: this session can't be told apart here (${only.blind.get(r.root)})` };
      const files = r.files.filter((f) => {
        const key = fileKey(r.root, f.path), keep = only.files.has(key);
        if (!keep) hidden.add(key);
        return keep;
      });
      return { ...r, files };
    });
  // A branch, commits, or turn repo stays listed with nothing in it, to show its base or its problem.
  return { folders: resolved, repos: repos.filter((r) => r.files.length || r.problem || scope.kind !== "uncommitted"), hidden };
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
  if (scope.kind === "turn") {
    const r = scope.repos[root];
    const problem = scope.gen === null ? "no agent turn seen since this pane opened"
      : scope.raced ? "files changed just as the turn started, so this turn is not shown"
      : !r ? "watched only after the turn started" : r.problem ?? null;
    const range = problem ? null : { from: r.from, to: r.to, objects: scope.objects };
    const changes = range ? await listChanges(root, exec, readText, range) : NONE;
    return { root, range, label: "last turn", base: null, missing: null, problem, ...changes };
  }
  return { root, range: null, label: null, base: null, missing: null, problem: null, ...(await listChanges(root, exec, readText)) };
}
