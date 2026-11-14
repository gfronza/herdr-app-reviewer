import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, TextView, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import {
  agents, closeOverlay, exec, focused, nextCommand, panes, pickFolder, props, readTextFile, run,
  setShared, settings, shared, theme as herdrTheme, watchFolder, writeTextFile,
} from "herdr";
import { collectScope, fileKey, MAX_FOLDERS, resolveRoots } from "./scope.js";
import { fileDiff, fileText } from "./git.js";
import { colorFor, createHighlighter, languageFor } from "./syntax.js";
import { createComment, formatReview, locate } from "./review.js";
import { moveLine, nextChange, nextFile, selectionRange } from "./nav.js";
import { commitOf, defaultBase, listBranches, listCommits, orderRun } from "./revs.js";
import { Turns, createTracker, workState } from "./turns.js";
import { fileRows } from "./tree.js";
import { lastLine, spans, splitLines } from "./split.js";
import { findRows, markRuns, nextMatch, searchFiles } from "./find.js";

// herdr.d.ts types theme colors as plain strings; gpui-kit wants `#${string}`.
const theme = () => /** @type {Record<string, import("gpui-kit").Color>} */ (herdrTheme());

// The diff reads like the terminals beside it; its row and column sizes were tuned at 12px.
function diffMetrics() {
  const s = settings(), size = Number(s.font_size ?? 12), k = size / 12;
  return { font: String(s.font_family ?? "JetBrains Mono"), size, row: Math.round(20 * k), gutter: Math.round(34 * k), char: 7 * k };
}

const KEYS = {
  j: "down", k: "up", "]": "next-change", "[": "prev-change", f: "next-file", F: "prev-file", tab: "switch-area",
  v: "select", c: "comment", e: "edit", d: "delete", y: "copy", s: "send", l: "layout", escape: "cancel",
  u: "scope-uncommitted", b: "scope-branch", t: "scope-turn", g: "scope-commits", B: "pick-base", G: "pick-commits",
  o: "session-only", z: "file-view", w: "diff-view", m: "markdown", "/": "find", n: "next-match", N: "prev-match", p: "find-file", P: "search-code",
};
// Code search holds every listed diff in memory and filters it on each keystroke; past this many
// rows one filter pass could run into the script time limit.
const SEARCH_ROWS = 100000;
const SEARCH_HITS = 200;
const WATCH_KEY = "reviewer.watch";
const LAYOUT_KEY = "reviewer.layout";
const BASES_KEY = "reviewer.bases";
const FILES_KEY = "reviewer.files";
const DIFF_KEY = "reviewer.diff";
const run_exec = (cmd, args, opts) => exec(cmd, args, { cwd: opts?.cwd });
// readTextFile rejects on bytes that are not UTF-8; git.js expects null for an unreadable file.
const readText = (path) => readTextFile(path).catch(() => null);
const repoName = (root) => root.split("/").pop();
const clock = (date) => date.toTimeString().slice(0, 5);
// A listed file; one kept for an earlier turn's comments also carries that turn's scope key.
const entryKey = (f) => (f.key ? `${f.key}\0${fileKey(f.root, f.file.path)}` : fileKey(f.root, f.file.path));
const isMarkdown = (path) => /\.(md|markdown)$/i.test(path);
const turnOf = (key) => Number(/^turn:(\d+)$/.exec(key)?.[1] ?? NaN);

// Opened with `mod.open:reviewer`, this copy is a one-shot launcher: it adds or
// removes the reviewer pane in the current tab, then closes itself.
function toggle() {
  const f = focused();
  if (!f) return;
  const open = panes().filter((p) => p.tab === f.tab && p.mod === "reviewer");
  if (open.length) { for (const p of open) run("pane.close", { pane: p.pane }); return; }
  const pane = f.pane ? panes().find((p) => p.pane === f.pane) : null;
  const base = pane?.cwd || f.cwd;
  if (!base) return;
  run("pane.split", { direction: "right", ...(f.pane ? { pane: f.pane } : {}), mod: "reviewer", props: { base, tab: f.tab } });
}

// The watch list lives in shared state, keyed by base folder, so it survives restarts.
const extraFolders = (base) => /** @type {Record<string, string[]>} */ (shared(WATCH_KEY) ?? {})[base] ?? [];
function saveExtraFolders(base, folders) {
  setShared(WATCH_KEY, { .../** @type {object} */ (shared(WATCH_KEY) ?? {}), [base]: folders });
}

// One layout for every reviewer, kept in shared state so it survives restarts.
const sideBySide = () => shared(LAYOUT_KEY) === "side";
// Tree or flat file list, one for every reviewer like the layout; the tree is the default.
const treeView = () => shared(FILES_KEY) !== "flat";
// Unified or split diff, also one for every reviewer; unified is the default.
const splitDiff = () => shared(DIFF_KEY) === "split";

// Picked bases for the branch scope, keyed by repo root (one per worktree), kept across restarts.
const bases = () => /** @type {Record<string, string>} */ (shared(BASES_KEY) ?? {});
function saveBase(root, name) {
  const { [root]: _, ...rest } = bases();
  setShared(BASES_KEY, name ? { ...rest, [root]: name } : rest);
}

export default class Reviewer extends View {
  init(_props, cx) {
    const p = props();
    if (p?.overlay) { toggle(); closeOverlay(p.overlay); return; }
    this.base = p?.base;
    this.tab = p?.tab;
    this.handle = cx.focus_handle();
    this.scroll = VirtualListScrollHandle.new();
    this.input = InputState.new({ placeholder: "Comment, Enter to save, Esc to cancel" });
    this.input.on("submit", (_e, cx) => this.saveComment(cx));
    this.filter = InputState.new({ placeholder: "Type to filter" });
    this.filter.on("change", (_e, cx) => this.filterTyped(cx));
    this.filter.on("submit", (e, cx) => this.choose(Boolean(e.shift), cx));
    this.finder = InputState.new({ placeholder: "Find in this diff: Enter keeps the matches, Esc clears them" });
    this.finder.on("change", (_e, cx) => this.findTyped(cx));
    this.finder.on("submit", (_e, cx) => this.closeFind(false, cx));
    // A press elsewhere takes the keyboard away from the box: close it, keeping its text, but leave
    // the keyboard where it went, which may be another pane.
    this.finder.on("blur", (_e, cx) => { if (this.findOpen) { this.findOpen = false; cx.notify(); } });
    this.findOpen = false; this.findQuery = ""; this.findFrom = 0; this.pendingRow = null;
    this.query = ""; this.chooser = null; this.scopeKind = "uncommitted"; this.commitPick = null;
    this.collapsed = new Set();
    this.scope = null; this.files = []; this.selected = null; this.diff = null; this.hl = null; this.hlGen = 0;
    this.area = "files"; this.cursor = 0; this.sel = null; this.comments = []; this.nextId = 1;
    this.box = null; this.picking = null; this.view = "changes"; this.notice = null; this.watching = new Map();
    this.visible = [];
    this.rendered = false;
    this.sessionOnly = false; this.since = new Date(); this.observe = createTracker(); this.turnError = null;
    // A turn's snapshots stay while an unsent comment, or one being written, can still be diffed.
    this.turns = new Turns(run_exec, {
      name: this.tab,
      keep: () => new Set([...this.comments, this.box?.draft].filter(Boolean).map((c) => turnOf(c.scope.key))),
    });
    cx.timer.every(250, (cx) => this.followAgents(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") (this.box ? this.input : this.chooser ? this.filter : this.findOpen ? this.finder : this.handle).focus();
        else this.act(command, cx);
        cx.notify();
      }
    });
    cx.timer.every(10000, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  folders() { return this.base ? [this.base, ...extraFolders(this.base)] : []; }

  /** @returns {import("./scope.js").Scope} */
  scopeSpec() {
    if (this.scopeKind === "branch") return { kind: "branch", bases: bases() };
    if (this.scopeKind === "commits") return { kind: "commits", ...this.commitPick };
    if (this.scopeKind === "turn") return { kind: "turn", ...this.turns.last() };
    return { kind: "uncommitted" };
  }

  // Comments belong to the scope they were made in and show only there: in the branch scope, to
  // the repo's base; in the commits scope, to the repo and its run; in the turn scope, to the turn.
  // Read from the loaded scope.
  keyFor(root) {
    const s = this.spec;
    if (s.kind === "branch") return `branch:${this.scope.repos.find((r) => r.root === root)?.base}`;
    if (s.kind === "commits") return `commits:${s.root}:${s.first}:${s.last}`;
    if (s.kind === "turn") return `turn:${s.gen}`;
    return "uncommitted";
  }

  // Until the new scope loads, nothing from the old one is shown, so nothing can be commented
  // on under the wrong scope.
  setScope(kind, cx) {
    this.scopeKind = kind; this.sel = null;
    this.scope = null; this.spec = null; this.files = [];
    this.pick(this.selected);
    this.refresh(cx);
  }

  // ── Loading ────────────────────────────────────────────────────────────

  // A refresh cut off by the script time limit never reaches its finally, so one running
  // far longer than any real refresh is taken as dead and replaced.
  refresh(cx) {
    if (this.loadingSince && Date.now() - this.loadingSince < 30000) { this.again = true; return; }
    this.loadingSince = Date.now();
    cx.spawn(async (cx) => {
      try {
        do {
          this.again = false;
          if (this.scopeKind === "turn" || this.sessionOnly) await this.turns.refresh();
          const spec = this.scopeSpec(), only = this.sessionOnly ? this.turns.session() : null;
          const scope = await collectScope(this.folders(), spec, run_exec, readText, only);
          // The scope, a base, a turn, or the session filter changed while this pass ran: its result belongs to neither.
          if (JSON.stringify(spec) !== JSON.stringify(this.scopeSpec()) || Boolean(only) !== this.sessionOnly) { this.again = true; continue; }
          this.scope = scope; this.spec = spec;
          this.files = [...this.scope.repos.flatMap((r) => r.files.map((file) => ({ root: r.root, range: r.range, file }))), ...this.orphans()];
          this.watch([...new Set(this.scope.folders.filter((f) => f.state === "repo").map((f) => f.root))], cx);
          if (!this.files.some((f) => entryKey(f) === this.selected)) {
            const first = this.shownFiles()[0] ?? this.files[0];
            this.pick(first ? entryKey(first) : null);
          }
          await this.loadDiff(cx);
          this.error = null;
        } while (this.again);
      } catch (e) { this.error = String(e); }
      finally { this.loadingSince = null; cx.notify(); }
    });
  }

  // Files that left the changes list (reverted or committed) but still hold unsent comments,
  // kept listed so those comments can be read, edited, and deleted. The turn scope also lists
  // files with comments from earlier turns, which no other scope can show. A file the session
  // filter hides keeps its comments hidden too.
  orphans() {
    const shown = new Set([...this.scope.repos.flatMap((r) => r.files.map((f) => fileKey(r.root, f.path))), ...this.scope.hidden]);
    const entries = new Map();
    for (const c of this.comments) {
      const own = c.scope.key === this.keyFor(c.root);
      const earlier = !own && this.spec.kind === "turn" && !Number.isNaN(turnOf(c.scope.key));
      if (!earlier && !(own && !shown.has(fileKey(c.root, c.path)))) continue;
      const entry = {
        root: c.root, orphan: true, ...(earlier ? { key: c.scope.key, label: c.scope.label } : {}),
        range: earlier ? c.scope.range : this.scope.repos.find((r) => r.root === c.root)?.range ?? c.scope.range,
        file: { path: c.path, status: "·", add: 0, del: 0, untracked: false, binary: false },
      };
      if (!entries.has(entryKey(entry))) entries.set(entryKey(entry), entry);
    }
    return [...entries.values()];
  }

  watch(roots, cx) {
    for (const root of this.watching.keys()) if (!roots.includes(root)) this.watching.delete(root);
    for (const root of roots) {
      if (this.watching.has(root)) continue;
      const token = {};
      this.watching.set(root, token);
      cx.spawn(async (cx) => {
        try {
          while (this.watching.get(root) === token) {
            const paths = await watchFolder(root);
            this.turns.wrote(root, Date.now(), paths);
            if (this.watching.get(root) === token) this.refresh(cx);
          }
        } catch { if (this.watching.get(root) === token) this.watching.delete(root); }
      });
    }
  }

  // Herdr sends no turn event: sampling the tab's agents finds the rest → work edge that starts one.
  followAgents(cx) {
    const { started, ended } = this.observe(workState(agents().filter((a) => a.tab === this.tab).map((a) => a.status)));
    if (!started && !ended) return;
    const at = Date.now();
    cx.spawn(async (cx) => {
      // Resolved now, not read from the loaded scope, which is empty while a scope switch loads.
      try {
        await (started ? this.turns.start((await resolveRoots(this.folders(), run_exec)).roots, at) : this.turns.end());
        this.turnError = null;
      } catch (e) { this.turnError = String(e); }
      this.refresh(cx);
    });
  }

  async loadDiff(cx) {
    const entry = this.files.find((f) => entryKey(f) === this.selected);
    if (!entry) { this.setDiff(null, cx); return; }
    const spec = this.spec;
    const [result, text] = await Promise.all([
      fileDiff(entry.root, entry.file, run_exec, readText, entry.range),
      isMarkdown(entry.file.path) ? fileText(entry.root, entry.file.path, run_exec, readText, entry.range) : null,
    ]);
    if (this.selected !== entryKey(entry) || this.spec !== spec) return;
    const label = entry.key ? entry.label : this.scope.repos.find((r) => r.root === entry.root)?.label ?? null;
    const scope = { key: entry.key ?? this.keyFor(entry.root), label, range: entry.range };
    this.setDiff({ key: this.selected, root: entry.root, path: entry.file.path, scope, untracked: entry.file.untracked, text, ...result }, cx);
    if (this.pendingRow === null) this.cursor = moveLine(this.diff.rows, this.cursor, 0);
    else { this.landOn(this.pendingRow); this.pendingRow = null; }
  }

  // A search hit's row comes from the diff read when the search opened; if the file changed since,
  // the nearest match at or after it stands in.
  landOn(row) {
    const matches = this.matches();
    this.cursor = moveLine(this.diff.rows, matches.includes(row) || !matches.length ? row : nextMatch(matches, row - 1, 1), 0);
    this.reveal();
  }

  setDiff(diff, cx) {
    this.diff = diff;
    const language = diff && languageFor(diff.path);
    this.hl = language ? createHighlighter(diff.rows, language) : null;
    this.highlight(cx);
  }

  // Colors in batches: one script slice is cut off after 500 ms, and sleep(0) starts a new one.
  highlight(cx) {
    const gen = ++this.hlGen, hl = this.hl;
    if (!hl) return;
    cx.spawn(async (cx) => {
      for (;;) {
        for (const { start, end } of this.visible) {
          hl.quick(start, end);
          cx.notify();
          await cx.sleep(0);
          if (gen !== this.hlGen) return;
        }
        const done = hl.step(10000);
        cx.notify();
        if (done) return;
        await cx.sleep(0);
        if (gen !== this.hlGen) return;
      }
    });
  }

  pick(key) {
    this.selected = key; this.diff = null; this.hl = null; this.hlGen++; this.cursor = 0; this.sel = null; this.pendingRow = null;
  }

  select(entry, cx) {
    const key = entryKey(entry);
    if (key === this.selected) return;
    this.pick(key);
    cx.spawn(async (cx) => {
      try { await this.loadDiff(cx); } catch (e) { this.error = String(e); }
      cx.notify();
    });
    cx.notify();
  }

  // ── Watched folders ────────────────────────────────────────────────────

  addFolder(cx) {
    cx.spawn(async (cx) => {
      if (this.folders().length >= MAX_FOLDERS) { this.say(`Already watching ${MAX_FOLDERS} folders; remove one first`, cx); return; }
      const folder = await pickFolder({ prompt: "Watch a folder" });
      if (folder && !this.folders().includes(folder)) {
        saveExtraFolders(this.base, [...extraFolders(this.base), folder]);
        this.refresh(cx);
      }
      cx.notify();
    });
  }

  removeFolder(folder, cx) {
    saveExtraFolders(this.base, extraFolders(this.base).filter((f) => f !== folder));
    this.refresh(cx);
  }

  // ── Comments ───────────────────────────────────────────────────────────

  commentAt(row) {
    const hit = this.layout().placed.find(({ span }) => span.start <= row && row <= span.end);
    return hit?.c ?? null;
  }

  openBox(cx, comment = null) {
    if (!this.diff?.rows.length) return;
    this.findOpen = false;
    if (comment) this.box = { id: comment.id };
    else {
      const { from, to } = this.range() ?? { from: this.cursor, to: this.cursor };
      if (!this.diff.rows.slice(from, to + 1).some((r) => r.kind !== "hunk")) return;
      // Anchored now, so a refresh while the box is open cannot move the comment to other lines.
      const draft = createComment({ id: 0, root: this.diff.root, path: this.diff.path, rows: this.diff.rows, from, to, text: "" });
      this.box = { draft: { ...draft, untracked: this.diff.untracked, scope: this.diff.scope } };
    }
    this.input.set_value(comment?.text ?? "");
    this.input.focus();
    cx.notify();
  }

  saveComment(cx) {
    const text = this.input.value().trim();
    if (!this.box || !text) return;
    if (this.box.id) this.comments = this.comments.map((c) => c.id === this.box.id ? { ...c, text } : c);
    else this.comments = [...this.comments, { ...this.box.draft, id: this.nextId++, text }];
    this.closeBox(cx);
  }

  closeBox(cx) {
    this.box = null; this.sel = null;
    this.handle.focus();
    cx.notify();
  }

  deleteComment(comment, cx) {
    this.comments = this.comments.filter((c) => c.id !== comment.id);
    cx.notify();
  }

  // ── Copy and send ──────────────────────────────────────────────────────

  // Every commented file is read again in its comment's scope, so a comment whose lines changed
  // is marked stale in the review. A range whose commits are gone has no lines left to match.
  async review() {
    const stale = new Set(), byFile = new Map();
    for (const c of this.comments) {
      const k = `${c.scope.key}\0${fileKey(c.root, c.path)}`;
      byFile.set(k, [...(byFile.get(k) ?? []), c]);
    }
    for (const list of byFile.values()) {
      const { root, path, scope, untracked } = list[0];
      const entry = this.spec && scope.key === this.keyFor(root) ? this.files.find((f) => !f.key && f.root === root && f.file.path === path) : null;
      const file = entry?.file ?? { path, untracked };
      const rows = (await fileDiff(root, file, run_exec, readText, entry ? entry.range : scope.range).catch(() => ({ rows: [] }))).rows;
      for (const c of list) if (locate(c, rows).stale) stale.add(c.id);
    }
    return formatReview(this.comments, stale);
  }

  copy(cx) {
    if (!this.comments.length) { this.say("No comments to copy", cx); return; }
    cx.spawn(async (cx) => {
      cx.write_to_clipboard(await this.review());
      this.say(`Copied ${this.comments.length} comment${this.comments.length === 1 ? "" : "s"}`, cx);
    });
  }

  send(cx) {
    if (!this.comments.length) { this.say("No comments to send", cx); return; }
    const targets = agents().filter((a) => a.tab === this.tab);
    if (!targets.length) { this.say("Not sent: no agent in this tab", cx); return; }
    if (targets.length === 1) this.sendTo(targets[0].address, cx);
    else { this.picking = targets.map((a) => a.address); this.notice = null; cx.notify(); }
  }

  // Fills the agent's input and never submits: the person presses Enter themselves.
  sendTo(address, cx) {
    this.picking = null;
    const agent = agents().find((a) => a.address === address);
    if (!agent) { this.say("Not sent: that agent is gone", cx); return; }
    if (agent.status === "blocked") { this.say("Not sent: the agent is waiting on a question", cx); return; }
    cx.spawn(async (cx) => {
      cx.write_to_clipboard(await this.review());
      run("pane.focus", { terminal: address });
      run("terminal.paste");
      this.comments = [];
      this.say("Sent to the agent's input; press Enter there to submit", cx);
    });
  }

  say(text, cx) { this.notice = text; cx.notify(); }

  // ── Base and commit pickers ────────────────────────────────────────────

  openChooser(chooser, load, cx) {
    if (this.box) { this.say("Save or cancel the comment first", cx); return; }
    this.findOpen = false;
    const c = { ...chooser, items: null, at: 0, mark: null };
    this.chooser = c; this.picking = null; this.notice = null; this.query = "";
    this.filter.set_value("");
    this.filter.focus();
    cx.spawn(async (cx) => {
      try { if (this.chooser === c) Object.assign(c, await load(cx, c)); }
      catch (e) { if (this.chooser === c) { this.closeChooser(cx); this.say(String(e), cx); } }
      cx.notify();
    });
    cx.notify();
  }

  closeChooser(cx) {
    this.chooser = null;
    this.handle.focus();
    cx.notify();
  }

  selectedRoot() {
    return this.files.find((f) => entryKey(f) === this.selected)?.root;
  }

  watchedRoots() {
    return [...new Set((this.scope?.folders ?? []).filter((f) => f.state === "repo").map((f) => f.root))];
  }

  openBasePicker(root, cx) {
    root ??= this.selectedRoot() ?? this.watchedRoots()[0];
    if (!root) { this.say("No repository to pick a base for", cx); return; }
    this.openChooser({ kind: "base", root }, async () => {
      const [items, defaultName] = await Promise.all([listBranches(root, run_exec), defaultBase(root, run_exec)]);
      return { items, defaultName };
    }, cx);
  }

  // Commits from every watched repo, newest first.
  openCommitPicker(cx) {
    const roots = this.watchedRoots();
    if (!roots.length) { this.say("No repository to pick commits from", cx); return; }
    this.openChooser({ kind: "commits", several: roots.length > 1 }, async () => {
      const logs = await Promise.all(roots.map((root) => listCommits(root, run_exec)));
      return { items: logs.flat().sort((a, b) => b.time - a.time) };
    }, cx);
  }

  openFilePicker(cx) {
    if (!this.files.length) { this.say("No files to pick from", cx); return; }
    this.openChooser({ kind: "files", several: this.watchedRoots().length > 1 }, async () => ({ items: this.shownFiles(new Set()) }), cx);
  }

  // Reads every listed file's diff once, in waves, so typing then filters in memory.
  openCodeSearch(cx) {
    const entries = this.shownFiles(new Set()).filter((f) => !f.file.binary);
    if (!entries.length) { this.say("No changed lines to search", cx); return; }
    this.openChooser({ kind: "code", total: entries.length, read: 0 }, async (cx, c) => {
      const items = [];
      let rows = 0;
      for (let i = 0; i < entries.length && rows < SEARCH_ROWS; i += 16) {
        // A diff cut short, unreadable, or failed is searched as far as it goes and counted, so "No matches" is not taken at its word.
        const wave = await Promise.all(entries.slice(i, i + 16).map(async (entry) => {
          const d = await fileDiff(entry.root, entry.file, run_exec, readText, entry.range).catch(() => null);
          return { entry, rows: d?.rows ?? [], partial: !d || d.cut || Boolean(d.notice) };
        }));
        if (this.chooser !== c) return {};
        items.push(...wave); rows += wave.reduce((n, w) => n + w.rows.length, 0);
        c.read = items.length; cx.notify();
      }
      return { items, cut: items.length < entries.length, partial: items.filter((it) => it.partial).length };
    }, cx);
  }

  chooserRows() {
    const c = this.chooser, q = this.query.toLowerCase();
    if (!c?.items) return [];
    if (c.kind === "files") {
      const terms = q.split(/\s+/).filter(Boolean);
      return c.items.filter((f) => terms.every((term) => `${repoName(f.root)}/${f.file.path}`.toLowerCase().includes(term)));
    }
    if (c.kind === "code") {
      if (c.found?.query !== this.query) c.found = { query: this.query, ...searchFiles(c.items, this.query, SEARCH_HITS) };
      return c.found.hits;
    }
    if (c.kind === "commits") return c.items.filter((x) => `${x.short} ${x.subject} ${repoName(x.root)}`.toLowerCase().includes(q));
    const rows = c.items.filter((b) => b.name.toLowerCase().includes(q));
    return this.query && !c.items.some((b) => b.name === this.query) ? [...rows, { typed: this.query }] : rows;
  }

  filterTyped(cx) {
    this.query = this.filter.value().trim();
    if (this.chooser) this.chooser.at = 0;
    cx.notify();
  }

  moveChooser(delta) {
    if (this.chooser) this.chooser.at = Math.max(0, Math.min(this.chooser.at + delta, this.chooserRows().length - 1));
  }

  // Enter picks the row; with Shift, a commit row marks one end of a run and Enter on the other end picks the run.
  choose(shift, cx) {
    const c = this.chooser, row = c && this.chooserRows()[c.at];
    if (!row) return;
    if (c.kind === "base") { this.chooseBase(c, row.typed ?? row.name, cx); return; }
    if (c.kind === "files") { this.openFile(row, null, cx); return; }
    if (c.kind === "code") { this.findQuery = this.query; this.openFile(row.entry, row.row, cx); return; }
    if (shift) { c.mark = row; this.say(`Run starts at ${row.short}; press Enter on its other end`, cx); return; }
    if (c.mark && c.mark.root !== row.root) { this.say("A run stays in one repo; pick its other end there", cx); return; }
    cx.spawn(async (cx) => {
      const run = await orderRun(row.root, (c.mark ?? row).sha, row.sha, run_exec);
      if (this.chooser !== c) return;
      if (!run) { this.say("Neither commit comes after the other; pick a run on one line of history", cx); return; }
      this.commitPick = { root: row.root, first: run[0], last: run[1] };
      this.notice = null;
      this.closeChooser(cx);
      this.setScope("commits", cx);
    });
  }

  chooseBase(c, name, cx) {
    cx.spawn(async (cx) => {
      if (!(await commitOf(c.root, name, run_exec))) { this.say(`No commit named "${name}"`, cx); return; }
      if (this.chooser !== c) return;
      saveBase(c.root, name === c.defaultName ? null : name);
      this.notice = null;
      this.closeChooser(cx);
      this.setScope("branch", cx);
    });
  }

  // Shows a file a search picked, opening its repo and folders, with the cursor on `row` if given.
  openFile(entry, row, cx) {
    const group = entry.key ? "earlier" : entry.orphan ? "orphans" : entry.root;
    for (const key of [...this.collapsed]) {
      const folder = key.startsWith(`${group}\0`) && key.slice(group.length + 1);
      if (key === group || (folder && entry.file.path.startsWith(`${folder}/`))) this.collapsed.delete(key);
    }
    this.notice = null;
    this.closeChooser(cx);
    this.area = row === null ? "files" : "diff";
    if (entryKey(entry) !== this.selected) this.select(entry, cx);
    if (row === null) return;
    // A line is found in the diff, not in the rendered file.
    if (isMarkdown(entry.file.path)) this.rendered = false;
    if (this.diff) this.landOn(row);
    else this.pendingRow = row;
  }

  // ── Keyboard ───────────────────────────────────────────────────────────

  onKey(e, cx) {
    if (this.box) {
      if (e.key === "escape") { this.closeBox(cx); cx.stop_propagation(); }
      return;
    }
    if (this.findOpen) {
      if (e.key === "escape") { this.closeFind(true, cx); cx.stop_propagation(); }
      return;
    }
    // The filter box takes typing and Enter; the arrows and Esc reach here.
    if (this.chooser) {
      const action = { down: "chooser-next", up: "chooser-prev", escape: "cancel" }[e.key];
      if (action) { this.act(action, cx); cx.stop_propagation(); }
      return;
    }
    if (e.modifiers.platform || e.modifiers.control || e.modifiers.alt) return;
    const key = e.modifiers.shift && e.key.length === 1 ? e.key.toUpperCase() : e.key;
    const action = this.picking && /^[1-9]$/.test(e.key) ? `pick-${e.key}` : KEYS[key];
    if (!action) return;
    this.act(action, cx);
    cx.stop_propagation();
  }

  // Keys and `reviewer.<action>` commands share these, so each one can be driven without a keyboard.
  act(action, cx) {
    const comment = () => this.area === "diff" && this.commentAt(this.cursor);
    const actions = {
      down: () => this.move(1, cx),
      up: () => this.move(-1, cx),
      "next-change": () => this.jumpChange(1),
      "prev-change": () => this.jumpChange(-1),
      "next-file": () => this.stepFile(1, cx),
      "prev-file": () => this.stepFile(-1, cx),
      "switch-area": () => { this.area = this.area === "files" ? "diff" : "files"; },
      // The first v starts a selection at the cursor, the second ends it there, a third starts over.
      select: () => {
        if (this.area !== "diff") return;
        this.sel = this.sel && this.sel.end === null ? { ...this.sel, end: this.cursor } : { anchor: this.cursor, end: null };
      },
      comment: () => { if (this.area === "diff") this.openBox(cx); },
      edit: () => { const c = comment(); if (c) this.openBox(cx, c); },
      delete: () => { const c = comment(); if (c) this.deleteComment(c, cx); },
      copy: () => this.copy(cx),
      send: () => this.send(cx),
      layout: () => setShared(LAYOUT_KEY, sideBySide() ? "stacked" : "side"),
      "scope-uncommitted": () => this.setScope("uncommitted", cx),
      "scope-branch": () => this.setScope("branch", cx),
      "scope-turn": () => this.setScope("turn", cx),
      "session-only": () => { this.sessionOnly = !this.sessionOnly; this.refresh(cx); },
      "scope-commits": () => (this.commitPick ? this.setScope("commits", cx) : this.openCommitPicker(cx)),
      "pick-base": () => this.openBasePicker(null, cx),
      "pick-commits": () => this.openCommitPicker(cx),
      "toggle-repo": () => this.fold(this.selectedRoot()),
      "file-view": () => setShared(FILES_KEY, treeView() ? "flat" : "tree"),
      "diff-view": () => setShared(DIFF_KEY, splitDiff() ? "unified" : "split"),
      markdown: () => {
        this.rendered = !this.rendered;
        if (this.markdownShown()) this.sel = null;
        else if (this.diff && !isMarkdown(this.diff.path)) this.say(`Markdown files will show ${this.rendered ? "rendered" : "as a diff"}`, cx);
      },
      "chooser-next": () => this.moveChooser(1),
      "chooser-prev": () => this.moveChooser(-1),
      "chooser-enter": () => this.choose(false, cx),
      "chooser-mark": () => this.choose(true, cx),
      // Esc cancels the nearest thing first; the find text goes only when nothing else was open.
      cancel: () => {
        const other = Boolean(this.chooser || this.picking || this.sel || this.notice);
        this.sel = null; this.picking = null; this.notice = null;
        if (this.chooser) this.closeChooser(cx);
        if (!other) { this.findQuery = ""; if (this.findOpen) this.closeFind(true, cx); }
      },
      find: () => this.openFind(cx),
      "find-file": () => this.openFilePicker(cx),
      "search-code": () => this.openCodeSearch(cx),
      "next-match": () => this.jumpMatch(1, cx),
      "prev-match": () => this.jumpMatch(-1, cx),
      dump: () => this.dump(),
      // Test seam, with dump: stands in for typing into the comment box and pressing Enter.
      "test-type": () => { if (props()?.dump && this.box) this.input.set_value(`test comment ${this.nextId}`); },
      "test-enter": () => { if (props()?.dump) this.saveComment(cx); },
      "test-filter": () => { if (props()?.dump && this.chooser) { this.filter.set_value(String(props().find ?? "")); this.filterTyped(cx); } },
      "test-find": () => { if (props()?.dump && this.findOpen) { this.finder.set_value(String(props().find ?? "")); this.findTyped(cx); } },
    };
    // The rendered file has no diff rows to anchor a comment to.
    if (this.markdownShown() && ["select", "comment", "edit", "delete"].includes(action)) { this.say("Comments go on the diff: press m to show it", cx); return; }
    const pick = /^pick-([1-9])$/.exec(action);
    if (pick && this.picking?.[Number(pick[1]) - 1]) this.sendTo(this.picking[Number(pick[1]) - 1], cx);
    else actions[action]?.();
    cx.notify();
  }

  // Test seam: a covered window stops drawing, so tests read state from a file instead.
  // Only a pane opened with a `dump` path prop writes one.
  dump() {
    const path = props()?.dump;
    if (!path) return;
    const state = {
      base: this.base, folders: this.scope?.folders, repos: this.scope?.repos?.map((r) => ({ root: r.root, cut: r.cut, files: r.files })),
      selected: this.selected?.replace("\0", ":"), area: this.area, cursor: this.cursor, sel: this.range(), box: this.box,
      diff: this.diff && { path: this.diff.path, notice: this.diff.notice, cut: this.diff.cut, rows: this.diff.rows.length },
      colored: this.diff ? this.diff.rows.filter((_, i) => this.hl?.runs(i)).length : 0,
      comments: this.comments, items: this.layout().items.filter((it) => it.comment).map((it) => ({ id: it.comment.id, text: it.text, stale: it.stale })),
      loading: Boolean(this.loadingSince), picking: this.picking, notice: this.notice, error: this.error, view: this.view, layout: sideBySide() ? "side" : "stacked", fileView: treeView() ? "tree" : "flat", diffView: splitDiff() ? "split" : "unified", rendered: this.markdownShown(), find: { open: this.findOpen, query: this.findQuery, matches: this.matches(), status: this.findStatus() }, markdown: this.diff?.text?.length ?? null,
      lines: this.layout().items.map((it) => (it.comment ? `# ${it.text}` : `${it.left ?? "-"}|${it.right ?? "-"}`)),
      scope: this.scopeKind, spec: this.spec, sessionOnly: this.sessionOnly, session: [...this.turns.session().files].map((k) => k.replace("\0", ":")),
      turnError: this.turnError, earlier: this.files.filter((f) => f.key).map((f) => `${f.key} ${f.file.path}`), collapsed: [...this.collapsed].map((k) => k.replace("\0", ":")),
      list: (({ repos, kept }) => [...repos, ...kept].flatMap((g) => g.rows.map((r) => "  ".repeat(r.depth) + (r.dir ? `${r.name}/${r.closed ? ` (${r.count})` : ""}` : r.prefix + r.name))))(this.groups()), labels: this.scope?.repos?.map((r) => ({ root: r.root, label: r.label, missing: r.missing, problem: r.problem })),
      chooser: this.chooser && {
        kind: this.chooser.kind, root: this.chooser.root, at: this.chooser.at, mark: this.chooser.mark?.short ?? null,
        rows: this.chooserRows().map((r) => this.chooser.kind === "files" ? r.file.path : this.chooser.kind === "code" ? `${r.entry.file.path}:${r.row}`
          : r.typed ?? r.name ?? `${repoName(r.root)} ${r.short} ${r.subject}`),
        read: this.chooser.read, cut: this.chooser.cut, partial: this.chooser.partial, more: this.chooser.found?.more,
      },
    };
    writeTextFile(`${path}-${Date.now()}.json`, JSON.stringify(state, null, 1), null);
  }

  range() {
    return this.sel && selectionRange(this.sel.anchor, this.sel.end ?? this.cursor);
  }

  move(delta, cx) {
    if (this.area === "files") this.stepFile(delta, cx);
    else if (this.diff) { this.cursor = moveLine(this.diff.rows, this.cursor, delta); this.reveal(); }
  }

  jumpChange(dir) {
    if (!this.diff) return;
    this.area = "diff";
    this.cursor = nextChange(this.diff.rows, this.cursor, dir);
    this.reveal();
  }

  // The file list in screen order: each repo's files, then the two groups kept for comments.
  // `collapsed` holds closed repos by root and closed folders by group and path.
  groups(collapsed = this.collapsed) {
    const tree = treeView(), rows = (group, list) => fileRows(list, tree, group, collapsed);
    return {
      repos: (this.scope?.repos ?? []).map((r) => ({
        repo: r, rows: collapsed.has(r.root) ? [] : rows(r.root, this.files.filter((f) => !f.orphan && f.root === r.root)),
      })),
      kept: [{ group: "orphans", title: "No longer changed, with comments", list: this.files.filter((f) => f.orphan && !f.key) },
        { group: "earlier", title: "Earlier turns, with comments", list: this.files.filter((f) => f.key) }]
        .filter((g) => g.list.length).map((g) => ({ title: g.title, rows: rows(g.group, g.list) })),
    };
  }

  // The files in screen order; by default those in closed repos and folders are left out.
  shownFiles(collapsed = this.collapsed) {
    const { repos, kept } = this.groups(collapsed);
    return [...repos, ...kept].flatMap((g) => g.rows.filter((r) => !r.dir).map((r) => r.entry));
  }

  stepFile(dir, cx) {
    const all = this.shownFiles(new Set()), shown = new Set(this.shownFiles().map(entryKey));
    const next = nextFile(all.map((f) => shown.has(entryKey(f))), all.findIndex((f) => entryKey(f) === this.selected), dir);
    if (next >= 0) this.select(all[next], cx);
  }

  fold(key) {
    if (!key) return;
    if (this.collapsed.has(key)) this.collapsed.delete(key);
    else this.collapsed.add(key);
  }

  reveal() {
    const item = this.layout().items.findIndex((it) => it.left === this.cursor || it.right === this.cursor);
    if (item >= 0) this.scroll.scroll_to_item(item);
  }

  // ── Find in the diff ───────────────────────────────────────────────────

  openFind(cx) {
    if (this.box || this.chooser) { this.say("Close the box below first", cx); return; }
    if (this.markdownShown()) { this.say("Find works on the diff: press m to show it", cx); return; }
    if (!this.diff?.rows.length) { this.say("No diff to find in", cx); return; }
    this.findOpen = true; this.findFrom = this.cursor; this.notice = null;
    this.finder.set_value(this.findQuery);
    this.finder.focus();
  }

  // Each keystroke jumps to the first match at or after where the find started.
  findTyped(cx) {
    this.findQuery = this.finder.value();
    const at = nextMatch(this.matches(), this.findFrom - 1, 1);
    if (at >= 0) { this.area = "diff"; this.cursor = at; this.reveal(); }
    cx.notify();
  }

  closeFind(clear, cx) {
    this.findOpen = false;
    if (clear) this.findQuery = "";
    this.handle.focus();
    cx.notify();
  }

  matches() {
    return findRows(this.diff?.rows ?? [], this.findQuery);
  }

  jumpMatch(dir, cx) {
    if (!this.findQuery) { this.say("Press / to find in the diff", cx); return; }
    if (this.markdownShown()) { this.say("Find works on the diff: press m to show it", cx); return; }
    const at = nextMatch(this.matches(), this.cursor, dir);
    if (at < 0) { this.say(`No match for "${this.findQuery}" in this file`, cx); return; }
    this.area = "diff"; this.cursor = at; this.reveal();
  }

  // Where the cursor sits among the matches, as the footer shows it.
  findStatus() {
    const matches = this.matches(), k = matches.indexOf(this.cursor);
    return matches.length ? `${k >= 0 ? `${k + 1} of ` : ""}${matches.length} match${matches.length === 1 ? "" : "es"}` : "no matches";
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  // Screen lines, each holding a diff row per side (the same row twice when unified), with each
  // comment's text as extra lines under the line of its last row. Each comment is
  // located once here: locating per drawn row ran past the script time limit with many comments.
  // A comment whose lines are gone sits above the first row, and the first row reaches it.
  layout() {
    if (!this.diff) return { items: [], placed: [], commented: new Set() };
    const placed = this.comments.filter((c) => c.scope.key === this.diff.scope.key && c.root === this.diff.root && c.path === this.diff.path).map((c) => {
      const at = locate(c, this.diff.rows);
      return { c, stale: at.stale, end: at.end, span: at.start < 0 ? { start: 0, end: 0 } : at };
    });
    const lines = splitDiff() ? splitLines(this.diff.rows) : this.diff.rows.map((_, i) => ({ left: i, right: i }));
    // Split, a block's last row can share a line above its other rows, so the comment goes under the lowest one.
    const after = new Map(), commented = new Set();
    for (const p of placed) {
      const line = p.end >= 0 ? lastLine(lines, p.span.start, p.span.end) : -1;
      after.set(line, [...(after.get(line) ?? []), p]);
      if (p.end >= 0) for (let i = p.span.start; i <= p.span.end; i++) commented.add(i);
    }
    const items = [];
    const commentRows = (list) => {
      for (const { c, stale } of list) {
        c.text.split("\n").forEach((line, i) => items.push({ comment: c, stale, text: line, first: i === 0 }));
      }
    };
    commentRows(after.get(-1) ?? []);
    lines.forEach((line, k) => { items.push(line); commentRows(after.get(k) ?? []); });
    return { items, placed, commented };
  }

  render(_cx) {
    if (props()?.overlay) return div();
    const t = theme();
    return v_flex().id("reviewer").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(this.header(t))
      .when(this.view === "changes", (e) => e.child(this.toolbar(t)))
      .child(this.view === "folders" ? this.foldersView(t) : this.changesView(t))
      .child(this.footer(t));
  }

  header(t) {
    const unsent = this.comments.length;
    return h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Reviewer"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.base ?? "No folder"))
      .when(unsent > 0, (e) => e.child(div().px(6).rounded(4).bg(t.accent).text_color(t.accent_foreground).text_size(11).child(`${unsent} unsent`)))

      .child(button(t, "folders", this.view === "folders" ? "Changes" : "Folders", (cx) => { this.view = this.view === "folders" ? "changes" : "folders"; cx.notify(); }));
  }

  // Its own row: beside the header's buttons, the scope tabs ran off a half-width pane.
  toolbar(t) {
    return h_flex().h(32).flex_none().px(12).gap(2).items_center().border_b(1).border_color(t.border)
      .children([["uncommitted", "Uncommitted"], ["branch", "Branch"], ["turn", "Last turn"], ["commits", "Commits"]].map(([kind, label]) =>
        button(t, `scope-${kind}`, label, (cx) => this.act(`scope-${kind}`, cx)).when(this.scopeKind === kind, (b) => b.bg(t.selected))))
      .child(div().flex_1())
      .child(button(t, "session-only", "This session", (cx) => this.act("session-only", cx)).when(this.sessionOnly, (b) => b.bg(t.selected)))
      .child(button(t, "layout", sideBySide() ? "Stacked" : "Side by side", (cx) => this.act("layout", cx)));
  }

  foldersView(t) {
    const states = this.folders().map((folder, i) => this.scope?.folders.find((f) => f.folder === folder)
      ?? { folder, state: i < MAX_FOLDERS ? "loading" : "over-limit" });
    const label = (f) => ({ missing: "missing", "not-repo": "not a git repository", loading: "", "over-limit": `not watched: the limit is ${MAX_FOLDERS}` })[f.state]
      ?? (f.root === f.folder ? "" : `in ${f.root}`);
    return v_flex().flex_1().min_h(0).p(8).gap(2).overflow_y_scrollbar()
      .children(states.map((f, i) => h_flex().id(`folder-${i}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).hover((s) => s.bg(t.hover))
        .child(div().flex_1().min_w(0).truncate().child(f.folder))
        .child(div().text_size(11).text_color(f.state === "repo" ? t.dim : t.blocked).child(label(f)))
        .child(f.folder === this.base
          ? div().w(60).text_size(11).text_color(t.dim).child("base")
          : button(t, `remove-${i}`, "Remove", (cx) => this.removeFolder(f.folder, cx)))))
      .child(h_flex().pt(6).child(button(t, "add-folder", "Add folder", (cx) => this.addFolder(cx))));
  }

  changesView(t) {
    const noRepo = this.scope && !this.scope.folders.some((f) => f.state === "repo");
    if (noRepo) {
      return v_flex().flex_1().p(16).gap(10)
        .child(div().text_color(t.muted).child("No git repository here. Add a folder that holds one."))
        .child(h_flex().child(button(t, "add-folder-empty", "Add folder", (cx) => this.addFolder(cx))));
    }
    // Side by side puts the files on the right, as herdr-reviewr does.
    return sideBySide()
      ? h_flex().flex_1().min_h(0).items_stretch().child(this.diffView(t)).child(this.fileList(t, true))
      : v_flex().flex_1().min_h(0).child(this.fileList(t, false)).child(this.diffView(t));
  }

  fileList(t, side) {
    const { repos, kept } = this.groups();
    const turnError = (this.scopeKind === "turn" || this.sessionOnly) && this.turnError;
    const rowsCount = repos.reduce((n, { repo: r, rows }) => n + 1 + (r.missing ? 1 : 0) + (r.problem || !r.files.length ? 1 : 0) + rows.length, 0)
      + kept.reduce((n, g) => n + 1 + g.rows.length, 0) + (this.sessionOnly ? 1 : 0) + (turnError ? 1 : 0);
    const frame = div().flex_none().relative().border_color(this.area === "files" ? t.accent : t.border);
    return (side ? frame.w("35%").max_w(320).border_l(1) : frame.h(Math.min(rowsCount * 24 + 12, 240)).min_h(44).border_b(1))
      .child(v_flex().id("files").absolute().inset_0().overflow_y_scroll().p(6)
        .when(Boolean(turnError), (e) => e.child(note(t, `Turn tracking failed: ${turnError}`)))
        .when(this.sessionOnly, (e) => e.child(note(t, `This session only: files the agent's turns changed since ${clock(this.since)}`)))
        .children(repos.map(({ repo: r, rows }) => v_flex()
          .child(this.repoHeader(t, r))
          .when(Boolean(r.missing), (e) => e.child(note(t, `${r.missing} no longer resolves; showing ${r.base ?? "nothing"}`)))
          .when(Boolean(r.problem), (e) => e.child(note(t, r.problem)))
          .when(!r.problem && !r.files.length, (e) => e.child(note(t, `No changes${this.sessionOnly ? " from this session's turns" : ""} ${r.base ? `since ${r.base}` : `in ${r.label}`}`)))
          .children(rows.map((row) => this.listRow(t, row)))
          .when(r.cut && !this.collapsed.has(r.root), (e) => e.child(note(t, "Showing the first 1,000 changed files")))))
        .children(kept.map(({ title, rows }) => v_flex()
          .child(h_flex().h(24).px(6).items_center().text_size(11).font_semibold().child(title))
          .children(rows.map((row) => this.listRow(t, row)))))
        .when(!repos.length && !kept.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error ?? (this.loadingSince || !this.scope ? "Loading changes…"
          : this.scopeKind === "commits" ? "The picked repo is no longer watched; press G to pick commits"
          : this.sessionOnly ? "No uncommitted changes from this session's turns" : "No uncommitted changes")))))
      .child(Scrollbar.vertical("files").absolute().inset_0());
  }

  // In the branch and commits scopes the header names the base or the commits, and a click picks again.
  repoHeader(t, r) {
    const pick = this.scopeKind === "branch" ? { label: r.base ? `vs ${r.base}` : "no base", open: (cx) => this.openBasePicker(r.root, cx) }
      : this.scopeKind === "commits" ? { label: r.label, open: (cx) => this.openCommitPicker(cx) } : null;
    const collapsed = this.collapsed.has(r.root);
    return h_flex().h(24).px(6).gap(6).items_center().text_size(11)
      .child(h_flex().id(`repo-${r.root}`).flex_none().gap(4).items_center().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { this.fold(r.root); cx.notify(); })
        .child(div().w(10).text_color(t.dim).child(collapsed ? "▸" : "▾"))
        .child(div().font_semibold().child(repoName(r.root)))
        .when(collapsed && r.files.length > 0, (e) => e.child(div().text_color(t.dim).child(`${r.files.length} file${r.files.length === 1 ? "" : "s"}`))))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(r.root))
      .when(Boolean(pick), (e) => e.child(div().id(`scope-pick-${r.root}`).px(6).rounded(4).flex_none().cursor_pointer().text_color(t.accent)
        .hover((s) => s.bg(t.hover)).on_click((_e, cx) => pick.open(cx)).child(pick.label)));
  }

  listRow(t, row) {
    if (!row.dir) return this.fileRow(t, row);
    return h_flex().id(`dir-${row.key}`).h(24).flex_none().pl(8 + row.depth * 14).pr(8).gap(6).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.fold(row.key); cx.notify(); })
      .child(div().w(10).flex_none().text_color(t.dim).child(row.closed ? "▸" : "▾"))
      .child(div().min_w(0).truncate().text_color(t.muted).child(`${row.name}/`))
      .when(row.closed, (e) => e.child(div().flex_none().text_size(11).text_color(t.dim).child(`${row.count} file${row.count === 1 ? "" : "s"}`)));
  }

  fileRow(t, { entry, prefix, name, depth }) {
    const { file } = entry, key = entryKey(entry);
    const color = file.status === "A" ? t.ansi2 : file.status === "M" ? t.blocked : file.status === "·" ? t.dim : t.ansi1;
    return h_flex().id(`file-${key}`).h(24).flex_none().pl(8 + depth * 14).pr(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(this.selected === key, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.area = "files"; this.select(this.files.find((f) => entryKey(f) === key), cx); })
      .child(div().w(12).flex_none().text_size(11).text_color(color).child(file.status))
      .child(h_flex().flex_1().min_w(0)
        .child(div().text_color(t.dim).truncate().child(prefix))
        .child(div().min_w(0).truncate().child(name)))
      .when(file.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${file.add}`)))
      .when(file.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${file.del}`)));
  }

  markdownShown() {
    return this.rendered && Boolean(this.diff) && isMarkdown(this.diff.path);
  }

  // The file as it reads at the scope's end, rendered; it scrolls on its own.
  markdownView(t) {
    const { key, text } = this.diff;
    return v_flex().flex_1().min_w(0).min_h(0)
      .child(note(t, "Rendered as it reads after these changes · m shows the diff"))
      .child(text === null ? div().p(12).text_color(t.dim).child("Nothing to render: the file is deleted here, binary, or over 1 MiB")
        // The root takes the keyboard back on a press, which would leave a text selection nothing can copy.
        : div().id("markdown").flex_1().min_h(0).overflow_y_scrollbar().px(16).py(12).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).child(TextView.markdown(`md-${key}`, text).selectable(true)));
  }

  diffView(t) {
    if (this.markdownShown()) return this.markdownView(t);
    const diff = this.diff, { items, commented } = this.layout(), m = diffMetrics(), split = splitDiff();
    const longest = Math.max(0, ...(diff?.rows ?? []).map((r) => r.text.length * m.char));
    // A split line gives each side the same width, so both sides' columns line up.
    const half = longest + m.gutter + 37, width = Math.max(300, split ? 2 * half : longest + 2 * m.gutter + 45);
    const sel = this.range();
    // overflow_x_scrollbar() wraps its child, so the flex size goes on a plain parent.
    return v_flex().flex_1().min_w(0).min_h(0).font_family(m.font).text_size(m.size)
      .when(Boolean(diff?.notice), (e) => e.child(div().p(12).text_color(t.dim).child(diff.notice)))
      .when(Boolean(diff?.cut), (e) => e.child(note(t, "Showing the first 1,500 lines")))
      .child(div().flex_1().min_h(0).relative().child(div().id("diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(width).h_full()
          .child(v_virtual_list("diff", items.length, m.row, (i) => items[i].comment ? `c${items[i].comment.id}-${i}` : `r${items[i].left ?? ""}:${items[i].right ?? ""}`,
            (range) => {
              this.visible = rowRange(items, range);
              return items.slice(range.start, range.end).map((it) => it.comment ? this.commentRow(t, it, m)
                : !split || diff.rows[it.left]?.kind === "hunk" ? this.diffRow(t, it.right, sel, commented, m)
                : h_flex().w_full().h(m.row).flex_none()
                  .child(this.halfRow(t, it.left, "old", sel, commented, m, half))
                  .child(this.halfRow(t, it.right, "new", sel, commented, m, half)));
            }).track_scroll(this.scroll).on_item_click((key, cx) => this.clickRow(key, cx)).size_full())))
        .child(Scrollbar.vertical("diff").viewport_from_layout().absolute().inset_0()))
      .when(!diff && this.files.length > 0, (e) => e.child(div().px(12).py(6).text_color(t.dim).child("Select a file to view its changes")));
  }

  // Rows are drawn inside the list's layout pass, where handlers throw; clicks arrive here by row key.
  // A split line has one key for both sides, so a click takes its new side.
  clickRow(key, cx) {
    if (!key.startsWith("r")) return;
    const [left, right] = key.slice(1).split(":");
    this.area = "diff"; this.cursor = Number(right || left); this.handle.focus();
    cx.notify();
  }

  diffRow(t, i, sel, commented, m) {
    const row = this.diff.rows[i];
    if (row.kind === "hunk") {
      return h_flex().id(`row-${i}`).w_full().h(m.row).flex_none().px(12).bg(t.raised).text_color(t.dim)
        .when(this.area === "diff" && this.cursor === i, (e) => e.bg(t.selected))
        .child(div().truncate().child(row.text));
    }
    const bg = this.rowBg(t, row, i, sel);
    return h_flex().id(`row-${i}`).w_full().h(m.row).flex_none().gap(8).when(Boolean(bg), (e) => e.bg(bg))
      .child(div().w(3).h_full().flex_none().when(commented.has(i), (e) => e.bg(t.accent)))
      .child(div().w(m.gutter).flex_none().text_right().text_color(t.dim).child(row.old === null ? "" : String(row.old)))
      .child(div().w(m.gutter).flex_none().text_right().text_color(t.dim).child(row.new === null ? "" : String(row.new)))
      .children(this.rowText(t, row, i));
  }

  // One side of a split line: its line number, sign, and text, or a blank where the other side has more lines.
  halfRow(t, i, side, sel, commented, m, width) {
    const cell = h_flex().w(width).h_full().flex_none().gap(8).overflow_hidden();
    if (i === null) return cell.bg(t.raised);
    const row = this.diff.rows[i], bg = this.rowBg(t, row, i, sel), number = row[side];
    return cell.when(Boolean(bg), (e) => e.bg(bg))
      .child(div().w(3).h_full().flex_none().when(commented.has(i), (e) => e.bg(t.accent)))
      .child(div().w(m.gutter).flex_none().text_right().text_color(t.dim).child(number === null ? "" : String(number)))
      .children(this.rowText(t, row, i));
  }

  rowBg(t, row, i, sel) {
    return this.area === "diff" && this.cursor === i ? t.selected
      : sel && sel.from <= i && i <= sel.to ? t.selection
      : row.kind === "add" ? t.ansi2 + "18" : row.kind === "del" ? t.ansi1 + "18" : null;
  }

  rowText(t, row, i) {
    const runs = markRuns(this.hl?.runs(i) ?? [{ text: row.text, scope: null }], this.findQuery);
    return [
      div().w(10).flex_none().text_color(row.kind === "add" ? t.ansi2 : row.kind === "del" ? t.ansi1 : t.dim)
        .child(row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""),
      h_flex().flex_1().min_w(0).children(runs.map((r) => {
        const color = r.scope ? colorFor(r.scope, t) : null;
        return div().flex_none().when(Boolean(color), (e) => e.text_color(/** @type {any} */ (color)))
          .when(Boolean(r.match), (e) => e.bg(/** @type {import("gpui-kit").Color} */ (`${t.accent}55`)).rounded(2)).child(r.text);
      })),
    ];
  }

  commentRow(t, it, m) {
    return h_flex().w_full().h(m.row).flex_none().pl(48).gap(8).bg(t.raised).text_color(it.stale ? t.dim : t.foreground)
      .child(div().w(3).h_full().flex_none().bg(t.accent))
      .child(div().min_w(0).truncate().child(it.text))
      .when(it.first && it.stale, (e) => e.child(div().text_size(11).text_color(t.blocked).child("stale: lines changed")));
  }

  chooserView(t) {
    const c = this.chooser, rows = this.chooserRows(), shown = 10;
    const at = Math.min(c.at, rows.length - 1), start = Math.max(0, Math.min(at - 4, rows.length - shown));
    const title = {
      base: () => `Base for ${repoName(c.root)}: type a branch or any revision, Enter to pick, Esc to cancel`,
      commits: () => "Pick a commit: Enter picks it, Shift+Enter marks one end of a run, Esc to cancel",
      files: () => "Go to a changed file: type parts of its path, Enter opens it, Esc to cancel",
      code: () => "Search the changed lines of every listed file: Enter opens the match, Esc to cancel",
    }[c.kind]();
    const picked = bases()[c.root];
    const row = (r, i) => {
      const body = r.typed !== undefined ? [div().flex_1().min_w(0).truncate().child(`Use revision "${r.typed}"`)]
        : c.kind === "files" ? [
          div().w(12).flex_none().text_size(11).text_color(t.dim).child(r.file.status),
          div().flex_1().min_w(0).truncate().child(r.file.path),
          div().text_size(11).text_color(t.dim).child(c.several ? repoName(r.root) : ""),
        ] : c.kind === "code" ? this.hitRow(t, r)
        : c.kind === "base" ? [
          div().flex_1().min_w(0).truncate().child(r.name),
          div().text_size(11).text_color(t.dim).child([r.name === c.defaultName && "default", r.name === picked && "picked", r.age].filter(Boolean).join(" · ")),
        ] : [
          div().flex_none().text_color(c.mark === r ? t.accent : t.dim).child(r.short),
          div().flex_1().min_w(0).truncate().child(r.subject),
          div().text_size(11).text_color(t.dim).child(c.several ? `${repoName(r.root)} · ${r.age}` : r.age),
        ];
      return h_flex().id(`choice-${start + i}`).h(24).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .when(start + i === at, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((e, cx) => { c.at = start + i; this.choose(e.modifiers.shift, cx); })
        .children(body);
    };
    // The root takes the keyboard back on a press; stopping it here keeps typing and Enter in the filter.
    return v_flex().id("chooser").flex_none().p(8).gap(4).border_t(1).border_color(t.border)
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .child(div().text_size(11).text_color(this.notice ? t.foreground : t.muted).child(this.notice ?? title))
      .child(div().id("chooser-box").h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent)
        .child(Input.new(this.filter).h_full().text_size(12).text_color(t.foreground)))
      .when(!c.items, (e) => e.child(note(t, c.kind === "code" ? `Reading the changed files: ${c.read} of ${c.total}` : "Loading…")))
      .when(Boolean(c.items) && !rows.length, (e) => e.child(note(t, c.kind === "code" && !this.query ? `Type to search ${c.items.length} files` : "No matches")))
      .children(rows.slice(start, start + shown).map(row))
      .when(Boolean(c.cut || c.partial || c.found?.more), (e) => e.child(note(t, [c.found?.more && `Showing the first ${SEARCH_HITS} matches`,
        c.cut && `searched the first ${c.items.length} of ${c.total} files`,
        c.partial && `${c.partial} file${c.partial === 1 ? "" : "s"} only partly searched (cut, unreadable, or failed)`].filter(Boolean).join("; "))));
  }

  hitRow(t, { entry, rows, row }) {
    const r = rows[row];
    return [
      div().flex_none().text_size(11).text_color(t.dim).child(`${entry.file.path}:${r.new ?? r.old}`),
      div().w(10).flex_none().text_color(r.kind === "add" ? t.ansi2 : r.kind === "del" ? t.ansi1 : t.dim).child(r.kind === "add" ? "+" : r.kind === "del" ? "−" : ""),
      div().flex_1().min_w(0).truncate().child(r.text.trim()),
    ];
  }

  footer(t) {
    if (this.chooser) return this.chooserView(t);
    if (this.box) {
      const label = this.box.draft ? `Comment on ${this.box.draft.path}` : "Edit comment";
      return v_flex().flex_none().p(8).gap(6).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.muted).child(label))
        // The root takes the keyboard back on a press, so a press in the box stops there.
        .child(div().id("comment-box").h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)));
    }
    if (this.findOpen) {
      return v_flex().flex_none().p(8).gap(6).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(this.notice ? t.foreground : t.muted).child(this.notice ?? `Find in ${this.diff?.path ?? "the diff"}${this.findQuery ? `: ${this.findStatus()}` : ""}`))
        .child(div().id("find-box").h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent)
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .child(Input.new(this.finder).h_full().text_size(12).text_color(t.foreground)));
    }
    if (this.picking) {
      const list = this.picking.map((address) => agents().find((a) => a.address === address) ?? { address, app: null, title: "", status: "gone" });
      return v_flex().flex_none().p(8).gap(4).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.muted).child("Send to which agent? Press its number, or Esc to cancel"))
        .children(list.map((a, i) => h_flex().id(`agent-${a.address}`).h(26).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.sendTo(a.address, cx))
          .child(div().w(14).text_color(t.dim).child(String(i + 1))).child(div().child(a.app ?? a.address)).child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(a.title))
          .child(div().text_size(11).text_color(a.status === "blocked" ? t.blocked : t.dim).child(a.status))));
    }
    return h_flex().flex_none().h(28).px(12).gap(12).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().text_color(this.error ? t.blocked : this.notice ? t.foreground : t.dim)
        .child(this.error ?? this.notice ?? (this.findQuery && this.diff && !this.markdownShown() ? `Find "${this.findQuery}": ${this.findStatus()} · n/N next/previous · Esc clears`
          : "j/k move · ]/[ change · f/F file · c comment · / find · p file · P search · w split · z tree · m markdown · u/b/t/g scope · o session · l layout · y copy · s send")));
  }
}

// The diff rows behind a visible range of list items, for coloring those first. Split, the rows on
// screen are not one run: a span from first to last would take in a long block off screen too.
function rowRange(items, range) {
  return spans(items.slice(range.start, range.end).flatMap((it) => (it.comment ? [] : [it.left, it.right])).filter((i) => i !== null));
}

function button(t, id, label, onClick) {
  return div().id(id).h(24).px(10).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(11).cursor_pointer()
    .hover((s) => s.bg(t.hover)).on_click((_e, cx) => onClick(cx)).child(label);
}

function note(t, text) {
  return div().px(12).py(4).text_size(11).text_color(t.dim).child(text);
}
