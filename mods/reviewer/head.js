// What the pane header shows for a reviewer pane, under the pane-heads contract
// (https://github.com/lucindo/herdr-app-pane-header/blob/main/CONTRACT.md): a header mod that
// follows it draws the title, the folder and these controls; each control names the command the
// header runs when it is clicked.
export const HEADS_KEY = "pane-heads";

const icon = (name) => `mods/reviewer/icons/${name}.svg`;

const SCOPES = [
  ["uncommitted", "Local", "Uncommitted changes (u)"],
  ["branch", "Branch", "The branch against its base (b)"],
  ["turn", "Turn", "The agent's last turn (t)"],
  ["commits", "Commits", "One commit or a run (g)"],
];

/**
 * @param {{ base: string | null, unsent: number, view: string, scope: string, sessionOnly: boolean, allFiles: boolean, sideBySide: boolean, wrap: boolean }} s
 */
export function headEntry(s) {
  const changes = s.view === "changes";
  // The scopes and toggles act on the changes, so the folders view shows only its way back, as today.
  const controls = changes ? [
    ...SCOPES.map(([kind, label, tooltip]) => ({ command: `reviewer.scope-${kind}`, label, tooltip, selected: s.scope === kind })),
    { command: "reviewer.session-only", icon: icon("session"), tooltip: "This session only (o)", selected: s.sessionOnly, gap: true },
    { command: "reviewer.all-files", icon: icon("files"), tooltip: "All files in one diff (a)", selected: s.allFiles },
    { command: "reviewer.layout", icon: icon("side"), tooltip: "Side by side (l)", selected: s.sideBySide },
    { command: "reviewer.wrap", icon: icon("wrap"), tooltip: "Wrap long lines", selected: s.wrap },
  ] : [];
  return {
    title: "Reviewer",
    detail: s.base ?? "No folder",
    ...(s.unsent > 0 ? { badge: `${s.unsent} unsent` } : {}),
    actions: [...controls, { command: "reviewer.folders", icon: icon("folder"), tooltip: changes ? "Folders" : "Back to the changes", selected: !changes },
      { command: "reviewer.settings", icon: icon("gear"), tooltip: "Settings (,)" }],
  };
}

// Header mods register here, with the fields they draw: { "<mod>": { version, draws: [...] } }.
export const HEADERS_KEY = "pane-heads-headers";
// Header mods from before that registry (contract v0) that draw `actions` list themselves here.
export const ACTIONS_KEY = "pane-heads-actions";

// The pane frame of the first visible tab block: hidden nodes skipped, a stack's shown child only.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter((c) => !c.hidden);
    children = [visible.find((c) => c.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

/** Whether the shown layout's pane header draws the controls, so the reviewer can leave its own rows out.
 *  A header shown only on hover would hide them most of the time. */
export function headerShowsControls(layout, headers, actionMods) {
  const header = paneFrame(layout)?.header;
  if (!header || (header.reveal ?? "always") !== "always") return false;
  const mod = header.content?.mod;
  const registered = headers?.[mod];
  if (registered) return registered.version >= 1 && Array.isArray(registered.draws) && registered.draws.includes("actions");
  return (actionMods ?? []).includes(mod);
}

/** Drops the entries of panes that are gone; `pane-heads` is persisted and would otherwise grow. */
export function pruneHeads(heads, livePanes) {
  return Object.fromEntries(Object.entries(heads).filter(([pane]) => livePanes.has(pane)));
}
