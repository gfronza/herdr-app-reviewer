// What the pane header shows for a reviewer pane. A header mod that reads the shared key
// `pane-heads` (the key Better Changes uses for its diff panes) draws the title, the folder and
// these controls; each control names the command the header runs when it is clicked.
export const HEADS_KEY = "pane-heads";

const icon = (name) => `mods/reviewer/icons/${name}.svg`;

const SCOPES = [
  ["uncommitted", "Local", "Uncommitted changes (u)"],
  ["branch", "Branch", "The branch against its base (b)"],
  ["turn", "Turn", "The agent's last turn (t)"],
  ["commits", "Commits", "One commit or a run (g)"],
];

/**
 * @param {{ base: string | null, unsent: number, view: string, scope: string, sessionOnly: boolean, sideBySide: boolean, wrap: boolean }} s
 */
export function headEntry(s) {
  const changes = s.view === "changes";
  // The scopes and toggles act on the changes, so the folders view shows only its way back, as today.
  const controls = changes ? [
    ...SCOPES.map(([kind, label, tooltip]) => ({ command: `reviewer.scope-${kind}`, label, tooltip, selected: s.scope === kind })),
    { command: "reviewer.session-only", icon: icon("session"), tooltip: "This session only (o)", selected: s.sessionOnly, gap: true },
    { command: "reviewer.layout", icon: icon("side"), tooltip: "Side by side (l)", selected: s.sideBySide },
    { command: "reviewer.wrap", icon: icon("wrap"), tooltip: "Wrap long lines", selected: s.wrap },
  ] : [];
  return {
    title: "Reviewer",
    detail: s.base ?? "No folder",
    ...(s.unsent > 0 ? { badge: `${s.unsent} unsent` } : {}),
    actions: [...controls, { command: "reviewer.folders", icon: icon("folder"), tooltip: changes ? "Folders" : "Back to the changes", selected: !changes }],
  };
}

// Header mods that draw `actions` list themselves here.
export const ACTIONS_KEY = "pane-heads-actions";

const paneHeader = (node) => node?.content?.pane?.header ?? (node?.children ?? []).map(paneHeader).find(Boolean) ?? null;

/** Whether the layout's pane header draws the controls, so the reviewer can leave its own rows out.
 *  A header shown only on hover would hide them most of the time. */
export function headerShowsControls(layout, actionMods) {
  const header = paneHeader(layout);
  return Boolean(header) && (header.reveal ?? "always") === "always" && (actionMods ?? []).includes(header.content?.mod);
}

/** Drops the entries of panes that are gone; `pane-heads` is persisted and would otherwise grow. */
export function pruneHeads(heads, livePanes) {
  return Object.fromEntries(Object.entries(heads).filter(([pane]) => livePanes.has(pane)));
}
