// Revisions the branch and commits scopes diff between: bases, branches, and commits.
import { READ } from "./git.js";

const tryGit = async (root, args, exec) => {
  const r = await exec("git", [...READ, ...args], { cwd: root });
  return r.code === 0 ? r.stdout.trim() : null;
};

// Resolves a revision to a commit id, or null. A leading "-" would read as an option.
export const commitOf = async (root, rev, exec) =>
  rev && !rev.startsWith("-") ? tryGit(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], exec) : null;

const isLocal = async (root, name, exec) => Boolean(name && (await commitOf(root, `refs/heads/${name}`, exec)));
const reflog = async (root, ref, exec) => (await tryGit(root, ["reflog", "show", "--format=%gs", ref, "--"], exec))?.split("\n") ?? [];

// The local branch HEAD's branch was made from, as the reflog recorded it. "Created from HEAD"
// leaves the name to the checkout that first moved onto the branch.
async function createdFrom(root, exec) {
  const branch = await tryGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], exec);
  if (!branch) return null;
  let from = /^branch: Created from (\S+)$/.exec((await reflog(root, `refs/heads/${branch}`, exec)).pop() ?? "")?.[1];
  if (from === "HEAD") {
    const moves = (await reflog(root, "HEAD", exec)).map((s) => /^checkout: moving from (\S+) to (\S+)$/.exec(s));
    from = moves.filter((m) => m?.[2] === branch).pop()?.[1];
  }
  // The base stays local: origin/dev stands for dev, and only when dev exists.
  if (from && !(await isLocal(root, from, exec)) && (await commitOf(root, `refs/remotes/${from}`, exec))) from = from.slice(from.indexOf("/") + 1);
  // A branch checked out from its own remote copy names itself.
  return from !== branch && (await isLocal(root, from, exec)) ? from : null;
}

// Without a pick, the branch scope diffs against a local branch: the one HEAD's branch was made
// from, then the one origin/HEAD names, init.defaultBranch, main, master. Never a remote-tracking branch.
export async function defaultBase(root, exec) {
  const from = await createdFrom(root, exec);
  if (from) return from;
  const remote = await tryGit(root, ["rev-parse", "--abbrev-ref", "--verify", "--quiet", "refs/remotes/origin/HEAD"], exec);
  const names = [remote?.replace(/^origin\//, ""), await tryGit(root, ["config", "init.defaultBranch"], exec), "main", "master"];
  for (const name of names) if (await isLocal(root, name, exec)) return name;
  return null;
}

/**
 * The branch scope's range: from where HEAD left its base to the working tree.
 * `missing` names a pick that no longer resolves, so the default stood in for it.
 * @returns {Promise<{ base: string | null, missing: string | null, range: import("./git.js").Range | null, problem: string | null }>}
 */
export async function branchRange(root, pick, exec) {
  const picked = await commitOf(root, pick, exec);
  const base = picked ? pick : await defaultBase(root, exec);
  const missing = pick && !picked ? pick : null;
  if (!(await commitOf(root, "HEAD", exec))) return { base, missing, range: null, problem: "no commits yet" };
  if (!base) return { base, missing, range: null, problem: "no base branch: press B to pick one" };
  const from = await tryGit(root, ["merge-base", await commitOf(root, base, exec), "HEAD"], exec);
  if (!from) return { base, missing, range: null, problem: `no history shared with ${base}` };
  return { base, missing, range: { from, to: null }, problem: null };
}

/**
 * A run of commits from `first` (oldest) to `last`, both included; a root commit diffs against
 * the empty tree, whose id depends on the repo's hash (SHA-1 or SHA-256). Null when either end
 * no longer resolves.
 * @returns {Promise<import("./git.js").Range | null>}
 */
export async function commitsRange(root, first, last, exec) {
  const [a, b] = await Promise.all([commitOf(root, first, exec), commitOf(root, last, exec)]);
  if (!a || !b) return null;
  const parent = await commitOf(root, `${a}^`, exec);
  // Without -w, hash-object only prints the id; it writes no object.
  return { from: parent ?? (await tryGit(root, ["hash-object", "-t", "tree", "/dev/null"], exec)), to: b };
}

/**
 * Orders two commits as [oldest, newest] by ancestry: log order puts a side branch's commits
 * between main's, and first^..last would then leave some out. Null when neither descends from
 * the other.
 */
export async function orderRun(root, x, y, exec) {
  if (x === y) return [x, y];
  const isAncestor = async (a, b) => (await exec("git", [...READ, "merge-base", "--is-ancestor", a, b], { cwd: root })).code === 0;
  if (await isAncestor(x, y)) return [x, y];
  if (await isAncestor(y, x)) return [y, x];
  return null;
}

const BRANCHES = 200;

/** Local and remote branches, most recently committed first. */
export async function listBranches(root, exec) {
  const out = await tryGit(root, ["for-each-ref", "--sort=-committerdate", `--count=${BRANCHES}`,
    "--format=%(refname)%00%(refname:short)%00%(committerdate:relative)", "refs/heads", "refs/remotes"], exec);
  return (out ? out.split("\n") : [])
    .map((line) => line.split("\0"))
    .filter(([ref]) => !ref.endsWith("/HEAD"))
    .map(([, name, age]) => ({ name, age }));
}

/** HEAD's latest `count` commits, newest first. */
export async function listCommits(root, exec, count = 100) {
  const out = await tryGit(root, ["log", `-n${count}`, "--format=%H%x00%h%x00%ct%x00%cr%x00%s", "HEAD", "--"], exec);
  return (out ? out.split("\n") : []).map((line) => {
    const [sha, short, time, age, subject] = line.split("\0");
    return { root, sha, short, time: Number(time), age, subject };
  });
}
