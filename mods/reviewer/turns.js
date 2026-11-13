// Turns: the tab's agents going from rest to work starts one, and a snapshot of every watched repo
// taken then is its baseline. Snapshots live in a private temp folder, never in the repo.
import { READ } from "./git.js";
import { fileKey } from "./scope.js";

// herdr reports `working` a little after the agent starts, and the pane samples it every 250 ms.
const RACE_BEFORE = 1250;
// A watch batch arrives up to about 150 ms after the write it reports.
const RACE_AFTER = 300;

/** @param {string[]} statuses @returns {"working" | "resting" | "held"} */
export function workState(statuses) {
  if (statuses.includes("working")) return "working";
  return statuses.every((s) => s === "idle" || s === "done") ? "resting" : "held";
}

// A start is rest → work; an end, a return to rest after work. `held` (blocked) keeps a turn open.
// The first sample starts nothing: a turn already running has no baseline.
export function createTracker() {
  let resting = false, worked = false;
  return (state) => {
    const edge = { started: state === "working" && resting, ended: worked && state === "resting" };
    resting = state === "resting";
    worked = state === "working" || (state === "held" && worked);
    return edge;
  };
}

// The snapshot's git never writes a split index: that would add a sharedindex file under .git.
const SNAP = [...READ, "-c", "core.splitIndex=false"];

async function git(exec, root, env, args) {
  const r = await exec("env", [...env, "git", ...SNAP, ...args], { cwd: root });
  if (r.code !== 0) throw new Error(`git ${args[0]} failed in ${root}: ${r.stderr.trim()}`);
  return r.stdout;
}

/**
 * The working tree as a tree object, staged into a copy of the repo's index (`cp -p` keeps its
 * mtime, without which git misses a same-size edit) and stored in `store`. No alternates while
 * writing: git would bump the mtime of each repo object it finds already there.
 */
async function snapshot(exec, root, gitDir, store, index) {
  const cp = await exec("cp", ["-p", `${gitDir}/index`, index], { cwd: root });
  // A repo with no index yet stages from nothing.
  if (cp.code !== 0 && (await exec("test", ["-e", `${gitDir}/index`], { cwd: root })).code === 0) throw new Error(cp.stderr.trim());
  const env = [`GIT_INDEX_FILE=${index}`, `GIT_OBJECT_DIRECTORY=${store}`];
  // A nested repo with no commit fails its own path; --ignore-errors stages the rest.
  await exec("env", [...env, "git", ...SNAP, "add", "-A", "--ignore-errors"], { cwd: root });
  // Clean files' blobs sit in the repo, not the store.
  return (await git(exec, root, env, ["write-tree", "--missing-ok"])).trim();
}

/** Paths that differ between two snapshot trees. */
async function changedPaths(exec, root, store, from, to) {
  const out = await git(exec, root, [`GIT_ALTERNATE_OBJECT_DIRECTORIES=${store}`], ["diff", "--name-only", "-z", "--no-renames", from, to]);
  return out.split("\0").filter(Boolean);
}

/**
 * @typedef {{ tree?: string, problem?: string, gitDir?: string, index?: string }} Base
 * @typedef {{ gen: number, dir: string, store: string, raceFrom: number, snapped: number, raced: boolean,
 *   ended: boolean, base: Map<string, Base>, now: Map<string, { tree?: string, paths?: string[], problem?: string }> }} Turn
 */

export class Turns {
  /**
   * @param {(cmd: string, args: string[], opts: { cwd: string }) => Promise<{ code: number, stdout: string, stderr: string }>} exec
   * @param {{ name?: string | null, keep?: () => Set<number>, clock?: () => number }} [opts] `name`: the
   *   pane's own temp folder name; `keep`: turns whose snapshots unsent comments still read.
   */
  constructor(exec, { name = null, keep = () => new Set(), clock = Date.now } = {}) {
    this.exec = exec; this.keep = keep; this.clock = clock;
    this.name = name && /^[\w-]+$/.test(name) ? name : null;
    this.scratch = null; this.next = 1; this.dirs = new Map();
    /** @type {Turn | null} the latest turn that changed something */
    this.current = null;
    /** @type {Turn | null} a started turn with no change yet */
    this.pending = null;
    this.done = new Set(); this.writes = new Map(); this.queue = Promise.resolve();
  }

  // One step at a time: a start, an end, and a refresh never interleave.
  run(fn) {
    const step = this.queue.then(fn);
    this.queue = step.catch(() => {});
    return step;
  }

  /** Makes this pane's temp folder, clearing what an earlier copy of the pane left in it. */
  open() {
    return this.run(() => this.ensureScratch());
  }

  // A named folder is the pane's own, so a reopened or reloaded pane replaces what the last copy
  // left, and a closed pane leaves at most one turn behind for the OS's temp cleanup.
  async ensureScratch() {
    if (this.scratch) return;
    const script = this.name
      ? 'd="${TMPDIR:-/tmp}"; d="${d%/}/herdr-reviewer-$1"; rm -rf "$d" && mkdir -p "$d" && printf %s "$d"'
      : 'd="${TMPDIR:-/tmp}"; mktemp -d "${d%/}/herdr-reviewer.XXXXXX"';
    this.scratch = (await this.must("sh", ["-c", script, "sh", this.name ?? ""])).trim();
  }

  /** A watched repo changed outside .git at `at`; a change as a turn starts may sit in its baseline. */
  wrote(root, at) {
    this.writes.set(root, at);
    for (const t of [this.pending, this.current]) {
      if (t && !t.ended && t.base.has(root) && at >= t.raceFrom && at <= t.snapped + RACE_AFTER) t.raced = true;
    }
  }

  start(roots, at) {
    return this.run(async () => {
      // An end the pane never saw: the old turn's changes so far are all it gets.
      if (this.current && !this.current.ended) this.freeze(this.current, await this.measure(this.current));
      if (this.pending) await this.drop(this.pending);
      await this.ensureScratch();
      const gen = this.next++, dir = `${this.scratch}/turn-${gen}`, store = `${dir}/objects`;
      await this.must("mkdir", ["-p", store]);
      this.dirs.set(gen, dir);
      const base = new Map();
      await Promise.all(roots.map(async (root, slot) => base.set(root, await this.baseOf(root, store, `${dir}/index-${slot}`))));
      const snapped = this.clock(), raceFrom = at - RACE_BEFORE;
      const raced = roots.some((root) => this.writes.get(root) >= raceFrom && this.writes.get(root) <= snapped + RACE_AFTER);
      this.pending = { gen, dir, store, raceFrom, snapped, raced, ended: false, base, now: new Map() };
    });
  }

  async baseOf(root, store, index) {
    try {
      const gitDir = (await git(this.exec, root, [], ["rev-parse", "--path-format=absolute", "--git-dir"])).trim();
      // A split index reads through a sharedindex file under .git, and reading it bumps that file's mtime.
      const shared = await this.exec("find", [gitDir, "-maxdepth", "1", "-name", "sharedindex.*"], { cwd: root });
      if (shared.stdout.trim()) return { problem: "git's split index is on in this repo, so it has no turn snapshot" };
      return { gitDir, index, tree: await snapshot(this.exec, root, gitDir, store, index) };
    } catch (e) { return { problem: `no turn snapshot: ${why(e)}` }; }
  }

  /** The tree of every snapshotted repo now, and the paths changed since the turn started. */
  async measure(t) {
    const now = new Map();
    await Promise.all([...t.base].map(async ([root, b]) => {
      if (!b.tree) { now.set(root, { problem: b.problem }); return; }
      try {
        const tree = await snapshot(this.exec, root, b.gitDir, t.store, b.index);
        now.set(root, { tree, paths: await changedPaths(this.exec, root, t.store, b.tree, tree) });
      } catch (e) { now.set(root, { problem: why(e) }); }
    }));
    return now;
  }

  /** Brings the latest turn up to date; a waiting turn takes over once it changes something. */
  refresh() {
    return this.run(async () => {
      if (this.pending) {
        const now = await this.measure(this.pending);
        if (changed(now)) { await this.promote(now); return; }
      }
      if (this.current) this.current.now = await this.measure(this.current);
    });
  }

  /** The agents rested: the turn's changes become part of the session. */
  end() {
    return this.run(async () => {
      if (this.pending) {
        const now = await this.measure(this.pending);
        if (!changed(now)) { await this.drop(this.pending); return; }
        await this.promote(now);
        this.freeze(this.current, now);
      } else if (this.current && !this.current.ended) this.freeze(this.current, await this.measure(this.current));
    });
  }

  freeze(t, now) {
    t.now = now; t.ended = true;
    for (const [root, n] of now) for (const path of n.paths ?? []) this.done.add(fileKey(root, path));
  }

  async promote(now) {
    this.current = { ...this.pending, now };
    this.pending = null;
    await this.collect();
  }

  async drop(t) {
    if (this.pending === t) this.pending = null;
    await this.collect();
  }

  // Keeps the latest turn, a waiting one, and those unsent comments read; removes the rest.
  async collect() {
    const keep = this.keep();
    for (const [gen, dir] of this.dirs) {
      if (gen === this.current?.gen || gen === this.pending?.gen || keep.has(gen)) continue;
      this.dirs.delete(gen);
      // Only folders this class made inside its own temp folder.
      if (dir.startsWith(`${this.scratch}/turn-`)) await this.exec("rm", ["-rf", dir], { cwd: this.scratch });
    }
  }

  async must(cmd, args) {
    const r = await this.exec(cmd, args, { cwd: "/" });
    if (r.code !== 0) throw new Error(`${cmd} failed: ${r.stderr.trim()}`);
    return r.stdout;
  }

  /** Files the seen turns changed, the running one so far included, as `fileKey`s. */
  session() {
    const live = this.current && !this.current.ended ? [...this.current.now].flatMap(([root, n]) => (n.paths ?? []).map((p) => fileKey(root, p))) : [];
    return new Set([...this.done, ...live]);
  }

  /**
   * The latest turn as the turn scope reads it: per repo, a range or the reason it has none.
   * @returns {{ gen: number | null, raced: boolean, objects: string | null, repos: Record<string, { from?: string, to?: string, problem?: string }> }}
   */
  last() {
    const t = this.current;
    if (!t) return { gen: null, raced: false, objects: null, repos: {} };
    /** @type {Record<string, { from?: string, to?: string, problem?: string }>} */
    const repos = {};
    for (const [root, b] of t.base) {
      const n = t.now.get(root);
      repos[root] = b.problem ? { problem: b.problem } : n?.problem ? { problem: `no turn snapshot: ${n.problem}` }
        : n ? { from: b.tree, to: n.tree } : { problem: "turn snapshot not read yet" };
    }
    return { gen: t.gen, raced: t.raced, objects: t.store, repos };
  }
}

const why = (e) => (e instanceof Error ? e.message : String(e));
// A repo it cannot read counts as a change: showing why beats hiding the turn.
const changed = (now) => [...now.values()].some((n) => n.paths?.length || n.problem);
