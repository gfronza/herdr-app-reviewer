import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, Scrollbar, v_virtual_list, VirtualListScrollHandle } from "gpui-base";
import {
  agents, closeOverlay, exec, focused, nextCommand, panes, pickFolder, props, readTextFile, run,
  setShared, settings, shared, theme as herdrTheme, watchFolder, writeTextFile,
} from "herdr";
import { collectScope } from "./scope.js";
import { fileDiff } from "./git.js";
import { colorFor, createHighlighter, languageFor } from "./syntax.js";
import { createComment, formatReview, locate } from "./review.js";
import { moveLine, nextChange, nextFile, selectionRange } from "./nav.js";

// herdr.d.ts types theme colors as plain strings; gpui-kit wants `#${string}`.
const theme = () => /** @type {Record<string, import("gpui-kit").Color>} */ (herdrTheme());

const ROW = 20;
const KEYS = {
  j: "down", k: "up", "]": "next-change", "[": "prev-change", f: "next-file", F: "prev-file", tab: "switch-area",
  v: "select", c: "comment", e: "edit", d: "delete", y: "copy", s: "send", escape: "cancel",
};
const WATCH_KEY = "reviewer.watch";
const run_exec = (cmd, args, opts) => exec(cmd, args, { cwd: opts?.cwd });
// readTextFile rejects on bytes that are not UTF-8; git.js expects null for an unreadable file.
const readText = (path) => readTextFile(path).catch(() => null);
const fileKey = (root, path) => `${root}\0${path}`;

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
    this.scope = null; this.files = []; this.selected = null; this.diff = null; this.hl = null; this.hlGen = 0;
    this.area = "files"; this.cursor = 0; this.sel = null; this.comments = []; this.nextId = 1;
    this.box = null; this.picking = null; this.view = "changes"; this.notice = null; this.watching = new Map();
    this.visible = { start: 0, end: 0 };
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "focus") this.handle.focus();
        else this.act(command, cx);
        cx.notify();
      }
    });
    cx.timer.every(10000, (cx) => this.refresh(cx));
    this.refresh(cx);
  }

  folders() { return this.base ? [this.base, ...extraFolders(this.base)] : []; }

  // ── Loading ────────────────────────────────────────────────────────────

  refresh(cx) {
    if (this.loading) { this.again = true; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        do {
          this.again = false;
          this.scope = await collectScope(this.folders(), run_exec, readText);
          this.files = this.scope.repos.flatMap((r) => r.files.map((file) => ({ root: r.root, file })));
          this.watch(this.scope.repos.map((r) => r.root), cx);
          if (!this.files.some((f) => fileKey(f.root, f.file.path) === this.selected)) {
            this.pick(this.files.length ? fileKey(this.files[0].root, this.files[0].file.path) : null);
          }
          await this.loadDiff(cx);
          this.error = null;
        } while (this.again);
      } catch (e) { this.error = String(e); }
      finally { this.loading = false; cx.notify(); }
    });
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
            await watchFolder(root);
            if (this.watching.get(root) === token) this.refresh(cx);
          }
        } catch { if (this.watching.get(root) === token) this.watching.delete(root); }
      });
    }
  }

  async loadDiff(cx) {
    const entry = this.files.find((f) => fileKey(f.root, f.file.path) === this.selected);
    if (!entry) { this.setDiff(null, cx); return; }
    const result = await fileDiff(entry.root, entry.file, run_exec, readText);
    if (this.selected !== fileKey(entry.root, entry.file.path)) return;
    this.setDiff({ key: this.selected, root: entry.root, path: entry.file.path, ...result }, cx);
    this.cursor = moveLine(this.diff.rows, this.cursor, 0);
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
        hl.quick(this.visible.start, this.visible.end);
        cx.notify();
        await cx.sleep(0);
        if (gen !== this.hlGen) return;
        const done = hl.step(10000);
        cx.notify();
        if (done) return;
        await cx.sleep(0);
        if (gen !== this.hlGen) return;
      }
    });
  }

  pick(key) {
    this.selected = key; this.diff = null; this.hl = null; this.hlGen++; this.cursor = 0; this.sel = null;
  }

  select(entry, cx) {
    const key = fileKey(entry.root, entry.file.path);
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
    if (!this.diff) return null;
    return this.comments.find((c) => {
      if (c.root !== this.diff.root || c.path !== this.diff.path) return false;
      const at = locate(c, this.diff.rows);
      return at.start <= row && row <= at.end;
    }) ?? null;
  }

  openBox(cx, comment = null) {
    if (!this.diff?.rows.length) return;
    if (comment) this.box = { id: comment.id };
    else {
      const { from, to } = this.range() ?? { from: this.cursor, to: this.cursor };
      if (!this.diff.rows.slice(from, to + 1).some((r) => r.kind !== "hunk")) return;
      this.box = { from, to };
    }
    this.input.set_value(comment?.text ?? "");
    this.input.focus();
    cx.notify();
  }

  saveComment(cx) {
    const text = this.input.value().trim();
    if (!this.box || !text) return;
    if (this.box.id) this.comments = this.comments.map((c) => c.id === this.box.id ? { ...c, text } : c);
    else {
      this.comments = [...this.comments, createComment({
        id: this.nextId++, root: this.diff.root, path: this.diff.path, rows: this.diff.rows, from: this.box.from, to: this.box.to, text,
      })];
    }
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

  // Every commented file is read again, so a comment whose lines changed is marked stale in the review.
  async review() {
    const stale = new Set(), byFile = new Map();
    for (const c of this.comments) byFile.set(fileKey(c.root, c.path), [...(byFile.get(fileKey(c.root, c.path)) ?? []), c]);
    for (const list of byFile.values()) {
      const entry = this.files.find((f) => f.root === list[0].root && f.file.path === list[0].path);
      const rows = entry ? (await fileDiff(entry.root, entry.file, run_exec, readText)).rows : [];
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

  // ── Keyboard ───────────────────────────────────────────────────────────

  onKey(e, cx) {
    if (this.box) {
      if (e.key === "escape") { this.closeBox(cx); cx.stop_propagation(); }
      return;
    }
    if (e.modifiers.platform || e.modifiers.control || e.modifiers.alt) return;
    const action = this.picking && /^[1-9]$/.test(e.key) ? `pick-${e.key}` : KEYS[e.key === "f" && e.modifiers.shift ? "F" : e.key];
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
      cancel: () => { this.sel = null; this.picking = null; this.notice = null; },
      dump: () => this.dump(),
      // Test seam, with dump: stands in for typing into the comment box and pressing Enter.
      "test-type": () => { if (props()?.dump && this.box) this.input.set_value(`test comment ${this.nextId}`); },
      "test-enter": () => { if (props()?.dump) this.saveComment(cx); },
    };
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
      comments: this.comments, items: this.items().filter((it) => it.comment).map((it) => ({ id: it.comment.id, text: it.text, stale: it.stale })),
      picking: this.picking, notice: this.notice, error: this.error, view: this.view,
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

  stepFile(dir, cx) {
    const at = this.files.findIndex((f) => fileKey(f.root, f.file.path) === this.selected);
    const next = nextFile(this.files, at, dir);
    if (next >= 0) this.select(this.files[next], cx);
  }

  reveal() {
    const item = this.items().findIndex((it) => it.row === this.cursor);
    if (item >= 0) this.scroll.scroll_to_item(item);
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  // Diff rows, with each comment's text as extra rows under its last line.
  items() {
    if (!this.diff) return [];
    const here = this.comments.filter((c) => c.root === this.diff.root && c.path === this.diff.path)
      .map((c) => ({ c, at: locate(c, this.diff.rows) }));
    const after = new Map();
    for (const h of here) after.set(h.at.end, [...(after.get(h.at.end) ?? []), h]);
    const items = [];
    const commentRows = (list) => {
      for (const { c, at } of list) {
        const lines = c.text.split("\n");
        lines.forEach((line, i) => items.push({ comment: c, stale: at.stale, text: line, first: i === 0 }));
      }
    };
    commentRows(after.get(-1) ?? []);
    this.diff.rows.forEach((row, i) => { items.push({ row: i }); commentRows(after.get(i) ?? []); });
    return items;
  }

  render(cx) {
    if (props()?.overlay) return div();
    const t = theme();
    return v_flex().id("reviewer").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .track_focus(this.handle).on_mouse_down("left", () => this.handle.focus())
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(this.header(t, cx))
      .child(this.view === "folders" ? this.foldersView(t, cx) : this.changesView(t, cx))
      .child(this.footer(t, cx));
  }

  header(t, cx) {
    const unsent = this.comments.length;
    return h_flex().h(36).flex_none().px(12).gap(8).items_center().border_b(1).border_color(t.border)
      .child(div().font_semibold().child("Reviewer"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.muted).child(this.base ?? "No folder"))
      .when(unsent > 0, (e) => e.child(div().px(6).rounded(4).bg(t.accent).text_color(t.accent_foreground).text_size(11).child(`${unsent} unsent`)))
      .child(button(t, "folders", this.view === "folders" ? "Changes" : "Folders", () => { this.view = this.view === "folders" ? "changes" : "folders"; cx.notify(); }));
  }

  foldersView(t, cx) {
    const states = this.scope?.folders ?? this.folders().map((folder) => ({ folder, state: "repo" }));
    const label = (f) => f.state === "missing" ? "missing" : f.state === "not-repo" ? "not a git repository" : f.root === f.folder ? "" : `in ${f.root}`;
    return v_flex().flex_1().min_h(0).p(8).gap(2).overflow_y_scrollbar()
      .children(states.map((f, i) => h_flex().id(`folder-${i}`).h(28).flex_none().px(8).gap(8).items_center().rounded(6).hover((s) => s.bg(t.hover))
        .child(div().flex_1().min_w(0).truncate().child(f.folder))
        .child(div().text_size(11).text_color(f.state === "repo" ? t.dim : t.blocked).child(label(f)))
        .child(f.folder === this.base
          ? div().w(60).text_size(11).text_color(t.dim).child("base")
          : button(t, `remove-${i}`, "Remove", () => this.removeFolder(f.folder, cx)))))
      .when(Boolean(this.scope?.cutFolders), (e) => e.child(note(t, "Watching the first 10 folders")))
      .child(h_flex().pt(6).child(button(t, "add-folder", "Add folder", () => this.addFolder(cx))));
  }

  changesView(t, cx) {
    const noRepo = this.scope && !this.scope.folders.some((f) => f.state === "repo");
    if (noRepo) {
      return v_flex().flex_1().p(16).gap(10)
        .child(div().text_color(t.muted).child("No git repository here. Add a folder that holds one."))
        .child(h_flex().child(button(t, "add-folder-empty", "Add folder", () => this.addFolder(cx))));
    }
    return v_flex().flex_1().min_h(0)
      .child(this.fileList(t, cx))
      .child(this.diffView(t, cx));
  }

  fileList(t, cx) {
    const repos = this.scope?.repos ?? [];
    const rowsCount = repos.reduce((n, r) => n + r.files.length + 1, 0);
    const active = this.area === "files";
    return div().flex_none().h(Math.min(rowsCount * 24 + 12, 240)).min_h(44).relative().border_b(1).border_color(active ? t.accent : t.border)
      .child(v_flex().id("files").absolute().inset_0().overflow_y_scroll().p(6)
        .children(repos.map((r) => v_flex()
          .child(h_flex().h(24).px(6).gap(6).items_center().text_size(11)
            .child(div().font_semibold().child(r.root.split("/").pop()))
            .child(div().min_w(0).truncate().text_color(t.dim).child(r.root)))
          .children(r.files.map((file) => this.fileRow(t, r.root, file, cx)))
          .when(r.cut, (e) => e.child(note(t, "Showing the first 1,000 changed files")))))
        .when(!repos.length, (e) => e.child(div().p(8).text_color(t.dim).child(this.error ?? (this.loading || !this.scope ? "Loading changes…" : "No uncommitted changes")))))
      .child(Scrollbar.vertical("files").absolute().inset_0());
  }

  fileRow(t, root, file, cx) {
    const key = fileKey(root, file.path), parts = file.path.split("/"), name = parts.pop();
    const color = file.status === "A" ? t.ansi2 : file.status === "M" ? t.blocked : t.ansi1;
    return h_flex().id(`file-${key}`).h(24).flex_none().px(8).gap(8).items_center().rounded(6).cursor_pointer()
      .when(this.selected === key, (e) => e.bg(t.selected)).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.area = "files"; this.select({ root, file }, cx); })
      .child(div().w(12).text_size(11).text_color(color).child(file.status))
      .child(h_flex().flex_1().min_w(0)
        .child(div().text_color(t.dim).truncate().child(parts.length ? parts.join("/") + "/" : ""))
        .child(div().min_w(0).truncate().child(name)))
      .when(file.add > 0, (e) => e.child(div().text_size(11).text_color(t.ansi2).child(`+${file.add}`)))
      .when(file.del > 0, (e) => e.child(div().text_size(11).text_color(t.ansi1).child(`−${file.del}`)));
  }

  diffView(t, cx) {
    const diff = this.diff, items = this.items(), font = String(settings().font_family ?? "JetBrains Mono");
    const width = Math.max(300, ...(diff?.rows ?? []).map((r) => r.text.length * 7 + 110));
    const sel = this.range();
    // overflow_x_scrollbar() wraps its child, so the flex size goes on a plain parent.
    return v_flex().flex_1().min_h(0).font_family(font).text_size(12)
      .when(Boolean(diff?.notice), (e) => e.child(div().p(12).text_color(t.dim).child(diff.notice)))
      .when(Boolean(diff?.cut), (e) => e.child(note(t, "Showing the first 1,500 lines")))
      .child(div().flex_1().min_h(0).relative().child(div().id("diff-x").size_full().overflow_x_scrollbar()
        .child(div().w_full().min_w(width).h_full()
          .child(v_virtual_list("diff", items.length, ROW, (i) => items[i].row !== undefined ? `r${items[i].row}` : `c${items[i].comment.id}-${i}`,
            (range) => {
              this.visible = rowRange(items, range);
              return items.slice(range.start, range.end).map((it) => it.comment ? this.commentRow(t, it) : this.diffRow(t, diff.rows[it.row], it.row, sel));
            }).track_scroll(this.scroll).on_item_click((key, cx) => this.clickRow(key, cx)).size_full())))
        .child(Scrollbar.vertical("diff").viewport_from_layout().absolute().inset_0()))
      .when(!diff && this.files.length > 0, (e) => e.child(div().px(12).py(6).text_color(t.dim).child("Select a file to view its changes")));
  }

  // Rows are drawn inside the list's layout pass, where handlers throw; clicks arrive here by row key.
  clickRow(key, cx) {
    if (!key.startsWith("r")) return;
    this.area = "diff"; this.cursor = Number(key.slice(1)); this.handle.focus();
    cx.notify();
  }

  diffRow(t, row, i, sel) {
    if (row.kind === "hunk") {
      return h_flex().id(`row-${i}`).w_full().h(ROW).flex_none().px(12).bg(t.raised).text_color(t.dim)
        .when(this.area === "diff" && this.cursor === i, (e) => e.bg(t.selected))
        .child(div().truncate().child(row.text));
    }
    const runs = this.hl?.runs(i) ?? [{ text: row.text, scope: null }];
    const commented = Boolean(this.commentAt(i));
    const bg = this.area === "diff" && this.cursor === i ? t.selected
      : sel && sel.from <= i && i <= sel.to ? t.selection
      : row.kind === "add" ? t.ansi2 + "18" : row.kind === "del" ? t.ansi1 + "18" : null;
    return h_flex().id(`row-${i}`).w_full().h(ROW).flex_none().gap(8).when(Boolean(bg), (e) => e.bg(bg))
      .child(div().w(3).h_full().flex_none().when(commented, (e) => e.bg(t.accent)))
      .child(div().w(34).flex_none().text_right().text_color(t.dim).child(row.old === null ? "" : String(row.old)))
      .child(div().w(34).flex_none().text_right().text_color(t.dim).child(row.new === null ? "" : String(row.new)))
      .child(div().w(10).flex_none().text_color(row.kind === "add" ? t.ansi2 : row.kind === "del" ? t.ansi1 : t.dim)
        .child(row.kind === "add" ? "+" : row.kind === "del" ? "−" : ""))
      .child(h_flex().flex_1().min_w(0).children(runs.map((r) => {
        const color = r.scope ? colorFor(r.scope, t) : null;
        return div().flex_none().when(Boolean(color), (e) => e.text_color(/** @type {any} */ (color))).child(r.text);
      })));
  }

  commentRow(t, it) {
    return h_flex().w_full().h(ROW).flex_none().pl(48).gap(8).bg(t.raised).text_color(it.stale ? t.dim : t.foreground)
      .child(div().w(3).h_full().flex_none().bg(t.accent))
      .child(div().min_w(0).truncate().child(it.text))
      .when(it.first && it.stale, (e) => e.child(div().text_size(11).text_color(t.blocked).child("stale: lines changed")));
  }

  footer(t, cx) {
    if (this.box) {
      const label = this.box.id ? "Edit comment" : `Comment on ${this.diff?.path ?? ""}`;
      return v_flex().flex_none().p(8).gap(6).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.muted).child(label))
        .child(div().h(30).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent)
          .child(Input.new(this.input).h_full().text_size(12).text_color(t.foreground)));
    }
    if (this.picking) {
      const list = this.picking.map((address) => agents().find((a) => a.address === address)).filter(Boolean);
      return v_flex().flex_none().p(8).gap(4).border_t(1).border_color(t.border)
        .child(div().text_size(11).text_color(t.muted).child("Send to which agent? Press its number, or Esc to cancel"))
        .children(list.map((a, i) => h_flex().id(`agent-${a.address}`).h(26).px(8).gap(8).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.sendTo(a.address, cx))
          .child(div().w(14).text_color(t.dim).child(String(i + 1))).child(div().child(a.app ?? a.address)).child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(a.title))
          .child(div().text_size(11).text_color(a.status === "blocked" ? t.blocked : t.dim).child(a.status))));
    }
    return h_flex().flex_none().h(28).px(12).gap(12).items_center().border_t(1).border_color(t.border).text_size(11).text_color(t.dim)
      .child(div().flex_1().min_w(0).truncate().text_color(this.error ? t.blocked : this.notice ? t.foreground : t.dim)
        .child(this.error ?? this.notice ?? "j/k move · ]/[ change · f/F file · v select · c comment · y copy · s send"));
  }
}

// The diff rows behind a visible range of list items, for coloring those first.
function rowRange(items, range) {
  const rows = items.slice(range.start, range.end).filter((it) => it.row !== undefined).map((it) => it.row);
  return rows.length ? { start: rows[0], end: rows[rows.length - 1] + 1 } : { start: 0, end: 0 };
}

function button(t, id, label, onClick) {
  return div().id(id).h(24).px(10).flex().items_center().rounded(6).border_1().border_color(t.border).text_size(11).cursor_pointer()
    .hover((s) => s.bg(t.hover)).on_click(() => onClick()).child(label);
}

function note(t, text) {
  return div().px(12).py(4).text_size(11).text_color(t.dim).child(text);
}
