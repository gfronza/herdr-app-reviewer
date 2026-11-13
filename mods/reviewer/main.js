import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { closeOverlay, focused, panes, props, run, theme as herdrTheme } from "herdr";

// herdr.d.ts types theme colors as plain strings; gpui-kit wants `#${string}`.
const theme = () => /** @type {Record<string, import("gpui-kit").Color>} */ (herdrTheme());

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
  run("pane.split", { direction: "right", ...(f.pane ? { pane: f.pane } : {}), mod: "reviewer", props: { base } });
}

export default class Reviewer extends View {
  init(_props, _cx) {
    const p = props();
    if (p?.overlay) { toggle(); closeOverlay(p.overlay); return; }
    this.base = p?.base;
  }

  render(_cx) {
    const t = theme();
    if (props()?.overlay) return div();
    return v_flex().size_full().bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(36).flex_none().px(12).items_center().border_b(1).border_color(t.border)
        .child(div().font_semibold().child("Reviewer"))
        .child(div().flex_1().min_w(0).ml(8).truncate().text_color(t.muted).child(this.base ?? "No folder")));
  }
}
