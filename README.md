# reviewer

A code-review pane for [Herdr App](https://herdr.dev). It shows the uncommitted changes in a
folder and in any other folders you add, as a unified diff with syntax colors. You comment on
lines, then copy the comments or place them in an agent's input for it to act on.

It is inspired by [herdr-reviewr](https://github.com/persiyanov/herdr-reviewr), the review plugin for the Herdr TUI, and
keeps its main keys.

## Install

1. Copy `mods/reviewer/` into `~/.config/herdr-app/mods/`. If you already have a mod named
   `reviewer`, give this folder another name.
2. Bind a key to open and close it. Add this to `~/.config/herdr-app/keys.json`, under
   `"global"` (this repo's `keys.json` holds the same line):

   ```json
   "cmd-r": "mod.open:reviewer"
   ```

   Any key works. Pick another if `cmd-r` is already yours.
3. Run `herdr-app check ~/.config/herdr-app/mods/reviewer` to confirm it loads.

## Use

Press the key in a tab. A reviewer pane opens beside the focused pane, bound to that pane's
folder (its *base folder*). It stays bound to that folder when you focus other panes. Press the
key again to close it.

The pane lists every uncommitted change: staged, unstaged, and untracked files, but not
git-ignored ones. Changes are grouped by repo. Select a file to see its diff. The list and the
open diff update when files change on disk.

**More folders.** Select **Folders** to see the watched folders. **Add folder** opens the system
folder picker. A folder inside a repo you already watch adds nothing new; the repo shows once.
**Remove** takes a folder off the list. The base folder cannot be removed. The list is saved per
base folder, so it comes back the next time a reviewer opens on that folder.

**Comments.** Move to a line and press `c`, or select lines with `v` first. Type the comment and
press Enter. A comment whose lines change on disk is kept and marked stale. If a commented
file stops changing (reverted or committed), it stays listed under "No longer changed, with
comments" until you send or delete its comments.

**Copy and send.** `y` copies the review: for each repo, its path, then each comment with its
file and line, the commented lines, and your text. `s` places the review in the agent's input in
the same tab and moves the keyboard there. It does not press Enter: you read it and submit. With
several agents in the tab, a picker asks which one. Sending clears the comments.

### Keys

| Key | Action |
| --- | --- |
| `j` / `k` | Move down / up |
| `]` / `[` | Next / previous change |
| `f` / `F` | Next / previous file |
| `Tab` | Switch between the file list and the diff |
| `v` | Start or end a line selection |
| `c` | Comment on the line or selection |
| `e` / `d` | Edit / delete the comment at the cursor |
| `y` | Copy the review |
| `s` | Send the review |
| `l` | Switch between stacked and side-by-side layout (kept for every reviewer, across restarts) |
| `Esc` | Clear the selection, or cancel the comment box |
| `Enter` | Save the comment box |
| `1`–`9` | Choose an agent in the send picker |

Clicking a file opens its diff; clicking a diff line moves the cursor there.

Each action is also a command, so you can bind it in `keys.json` under `"mod:reviewer"`:
`reviewer.down`, `reviewer.up`, `reviewer.next-change`, `reviewer.prev-change`,
`reviewer.next-file`, `reviewer.prev-file`, `reviewer.switch-area`, `reviewer.select`,
`reviewer.comment`, `reviewer.edit`, `reviewer.delete`, `reviewer.copy`, `reviewer.send`,
`reviewer.layout`, `reviewer.cancel`.

## What it runs and reads

- It runs `git` in each watched repo, read-only: `status`, `diff`, and `rev-parse`, with
  `--no-optional-locks` and settings that keep git from writing the index. It never stages,
  commits, or changes a file, the index, or a ref.
- It reads files outside its own folder: the files in the folders you watch, to show untracked
  files and count their lines.
- It watches those repos for changes on disk.
- It writes the clipboard when you copy or send.
- It reaches no network.

## Limitations

- Parallel sessions in the same base folder share one watch list.
- Local machine only: spaces on other machines are not supported.
- Unsent comments are lost when the pane closes.
- Sending replaces the clipboard contents.
- Tested on macOS only; Linux and Windows are untested.
- Files over 1 MiB, and untracked files that are not UTF-8 text, are listed but their contents
  are not shown.
- Up to 10 folders can be watched, base folder included.
- Lines longer than 500 characters are shown without syntax colors. Up to 1,000 changed files
  per repo and 1,500 diff lines per file are shown; past those, a notice says the view is cut.

## Credits

Syntax colors come from [highlight.js](https://highlightjs.org) 11.12.0, vendored in
`mods/reviewer/vendor/` with its BSD-3-Clause license.

## License

MIT. See `LICENSE`.
