// Revisions the branch and commits scopes diff between: bases, branches, and commits.
import { READ } from "./git.js";

const tryGit = async (root, args, exec) => {
  const r = await exec("git", [...READ, ...args], { cwd: root });
  return r.code === 0 ? r.stdout.trim() : null;
};

// Resolves a revision to a commit id, or null. A leading "-" would read as an option.
export const commitOf = async (root, rev, exec) =>
  rev && !rev.startsWith("-") ? tryGit(root, ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], exec) : null;

// Without a pick, the branch scope diffs against origin/HEAD, then init.defaultBranch, main, master.
export async function defaultBase(root, exec) {
  const names = [
    await tryGit(root, ["rev-parse", "--abbrev-ref", "--verify", "--quiet", "refs/remotes/origin/HEAD"], exec),
    await tryGit(root, ["config", "init.defaultBranch"], exec),
    "main",
    "master",
  ];
  for (const name of names) if (name && (await commitOf(root, name, exec))) return name;
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

const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/**
 * A run of commits from `first` (oldest) to `last`, both included; a root commit diffs against
 * the empty tree. Null when either end no longer resolves.
 * @returns {Promise<import("./git.js").Range | null>}
 */
export async function commitsRange(root, first, last, exec) {
  const [a, b] = await Promise.all([commitOf(root, first, exec), commitOf(root, last, exec)]);
  if (!a || !b) return null;
  return { from: (await commitOf(root, `${a}^`, exec)) ?? EMPTY_TREE, to: b };
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

const COMMITS = 100;

/** HEAD's latest commits, newest first. */
export async function listCommits(root, exec) {
  const out = await tryGit(root, ["log", `-n${COMMITS}`, "--format=%H%x00%h%x00%ct%x00%cr%x00%s", "HEAD", "--"], exec);
  return (out ? out.split("\n") : []).map((line) => {
    const [sha, short, time, age, subject] = line.split("\0");
    return { root, sha, short, time: Number(time), age, subject };
  });
}
