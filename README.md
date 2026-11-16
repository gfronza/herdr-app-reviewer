# reviewer

A code-review pane for [Herdr App](https://herdr.dev). It shows the changes in a folder and in
any other folders you add, as a unified diff with syntax colors: uncommitted changes, everything
on the branch, what the agent's last turn changed, or chosen commits. You comment on lines, then copy the comments or place them in
an agent's input for it to act on.

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
git-ignored ones. Changes are grouped by repo, and each repo's files show as a folder tree:
folders first, then files, and a folder holding only one folder shares its row (`src/app/`).
Click a repo's name or a folder to collapse or expand it; `f`/`F` skip the files it hides. `z`
switches between the tree and a flat list of paths; the choice is kept for every reviewer, across
restarts. Select a file to see its diff. The list and the open diff update when files change on
disk.

**Split diff.** `w` shows the old code on the left and the new code on the right, each changed
line beside its new version, and `w` again goes back to one column. The choice is kept for every
reviewer, across restarts. Movement, selection, and comments work the same: `j`/`k` go through a
changed block's removed lines, then its added ones. A click on a line selects its new side.

**Rendered Markdown.** `m` shows a Markdown file (`.md`, `.markdown`) rendered, as it reads
after the changes, in place of its diff; `m` again brings the diff back. It stays on as you move
between files, and other files keep showing their diff. Opening a search match in a Markdown
file (`P`, below) turns it off, to show the matching line. Comments go on the diff, so `v`, `c`, `e`,
and `d` ask you to switch back first.

**Find in the diff.** `/` opens a find box under the diff. As you type, the cursor jumps to the
next match from where it was, wrapping around, and every match is marked; case is ignored. Enter closes the box and keeps the
matches; `n` and `N` go to the next and previous one, wrapping around, also in other files you
open. `Esc` clears them. Find looks at the lines the diff shows, not the whole file.

**Search.** `p` lists the files in the pane; type parts of a path to narrow it, and Enter opens
the file, expanding its repo and folders if they were collapsed. `P` searches the changed lines
of every listed file, removed and context lines included, and Enter opens the match at its line,
with the search text kept as the find text for `n`/`N`. Both search what the current scope lists,
not the rest of the repo. Code search reads every listed diff when it opens; past 100,000 lines it
says how many files it covered, and it shows the first 200 matches.

**Scopes.** The buttons under the header, or `u`, `b`, `t`, and `g`, choose what the pane diffs:

- **Uncommitted** (`u`), the default: changes since the last commit.
- **Branch** (`b`): everything since the branch left its base, commits and uncommitted changes
  together. Each repo diffs against its own base, named in its heading ("vs main"). The base is
  the branch yours was made from, as git's reflog recorded it (`origin/dev` counts as your local
  `dev`). Without that record, it is your local copy of the remote's default branch (as
  `origin/HEAD` names it), else `init.defaultBranch`, `main`, or `master`; always a local branch.
  To pick another, press `B` or click the base name. Type to filter the branches, or type any
  revision, like `HEAD~2` or a tag. The pick is kept per repo across restarts, even when you switch
  branches. To drop it, choose **Forget the pick** at the top of the list, or pick the default.
- **Last turn** (`t`): what the agent's latest turn changed, across every watched repo, commits
  made during the turn included. A turn starts when the agents in the reviewer's tab go from idle
  to working; the pane then saves a snapshot of each watched repo and diffs against it. A turn that
  changes nothing leaves the previous one on screen. The pane sees only turns that start while it
  is open.
- **Commits** (`g`): one commit or a run of commits, in one repo. `G` lists recent commits from
  every watched repo. Enter picks one. For a run, press Shift+Enter on one end, then Enter on the
  other; one end must come after the other in history. `g` returns to the last pick.

Every reviewer opens on Uncommitted.

**This session only.** The **This session** button, or `o`, narrows any scope to the files the
agent's turns changed since the pane opened. Edits made between turns are left out. Off by default.

**More folders.** Select **Folders** to see the watched folders. **Add folder** opens the system
folder picker. A folder inside a repo you already watch adds nothing new; the repo shows once.
**Remove** takes a folder off the list. The base folder cannot be removed. The list is saved per
base folder, so it comes back the next time a reviewer opens on that folder.

**Comments.** Move to a line and press `c`, or select lines with `v` first. Type the comment and
press Enter. A comment belongs to the scope it was made in and shows only there: in Branch, to the
repo's base at the time; in Commits, to that repo and run; in Last turn, to that turn. A comment whose
lines change on disk is kept and marked stale. If a commented
file stops changing (reverted or committed), it stays listed under "No longer changed, with
comments" until you send or delete its comments.

**Copy and send.** `y` copies the review: for each repo, its path, then each comment with its
file and line (with its scope, when not Uncommitted), the commented lines, and your text. `s` places the review in the agent's input in
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
| `u` / `b` / `t` / `g` | Scope: uncommitted / branch / last turn / commits |
| `o` | Show only this session's files, or all files |
| `m` | Show a Markdown file rendered, or its diff |
| `/` | Find in the diff |
| `n` / `N` | Next / previous match |
| `p` | Go to a listed file by name |
| `P` | Search the changed lines of every listed file |
| `w` | Switch the diff between one column and old beside new (kept for every reviewer, across restarts) |
| `z` | Switch the file list between a folder tree and a flat list (kept for every reviewer, across restarts) |
| `B` / `G` | Pick the base branch / pick commits |
| `Esc` | Clear the selection and the find matches, or cancel the comment box or a picker |
| `Enter` | Save the comment box, close the find box, or choose in a picker |
| `↑` / `↓` | Move in a picker |
| `Shift+Enter` | Mark one end of a run in the commit picker |
| `1`–`9` | Choose an agent in the send picker |

Clicking a file opens its diff; clicking a diff line moves the cursor there.

Each action is also a command, so you can bind it in `keys.json` under `"mod:reviewer"`:
`reviewer.down`, `reviewer.up`, `reviewer.next-change`, `reviewer.prev-change`,
`reviewer.next-file`, `reviewer.prev-file`, `reviewer.switch-area`, `reviewer.select`,
`reviewer.comment`, `reviewer.edit`, `reviewer.delete`, `reviewer.copy`, `reviewer.send`,
`reviewer.layout`, `reviewer.cancel`, `reviewer.scope-uncommitted`, `reviewer.scope-branch`,
`reviewer.scope-turn`, `reviewer.scope-commits`, `reviewer.session-only`, `reviewer.pick-base`,
`reviewer.pick-commits`, `reviewer.file-view`, `reviewer.diff-view`, `reviewer.markdown`, `reviewer.find`, `reviewer.next-match`, `reviewer.prev-match`, `reviewer.find-file`, `reviewer.search-code`, `reviewer.folders`, and
`reviewer.toggle-repo` (collapses or expands the selected file's repo; no key by default).

## What it runs and reads

- It runs `git` in each watched repo, read-only: `status`, `diff`, `ls-files`, `rev-parse`,
  `merge-base`, `log`, `for-each-ref`, `cat-file` (to render a Markdown file as a commit or turn
  holds it), and `config` (to read `init.defaultBranch`), with
  `--no-optional-locks` and settings that keep git from writing the index. It never stages,
  commits, or changes a file, the index, or a ref.
- For Last turn and This session, it snapshots each watched repo when a turn starts: it copies the
  repo's index into a temp folder and runs `git add -A` and `git write-tree` there, with
  `GIT_INDEX_FILE` and `GIT_OBJECT_DIRECTORY` pointing at that folder. Nothing is written inside
  the repo. Each pane keeps one folder, `herdr-reviewer-<tab id>` in `$TMPDIR`, holding the latest
  turn and any turn that unsent comments were made in. It runs `sh`, `cp`, `find`, `mkdir`, and
  `rm` on that folder only.
- It reads the status of the agents in its tab.
- It reads files outside its own folder: the files in the folders you watch, to show untracked
  files, count their lines, and render Markdown files.
- It watches those repos for changes on disk.
- It writes the clipboard when you copy or send.
- It writes its title, folder and controls into the shared key `pane-heads`, under its pane id,
  for a pane header mod that shows them. Each write drops the entries of panes that are gone.
- It reaches no network.

## Limitations

- Parallel sessions in the same base folder share one watch list.
- Local machine only: spaces on other machines are not supported.
- Unsent comments are lost when the pane closes.
- Last turn and This session see only turns that start while the pane is open, and they count
  every change in the watched repos during a turn, including changes from other programs or
  sessions. If a file changes just as a turn starts, that turn shows nothing and says why; This
  session may then miss that file.
- A closed pane leaves its last turn's snapshot in its temp folder until the system cleans it up.
- Repos with git's split index on (`core.splitIndex`) have no Last turn: reading a split index
  would change a file under `.git`.
- Sending replaces the clipboard contents.
- Tested on macOS only; Linux and Windows are untested.
- Files over 1 MiB, and untracked files that are not UTF-8 text, are listed but their contents
  are not shown.
- Up to 10 folders can be watched, base folder included.
- Lines longer than 500 characters are shown without syntax colors. Up to 1,000 changed files
  per repo and 1,500 diff lines per file are shown; past those, a notice says the view is cut.

## Roadmap

Planned next, in this order. Plans may change.

- **v1.4, durability and reach:** unsent comments that survive closing the pane; Linux and
  Windows tested; spaces on other machines.
- **v2, beyond changes:** a tab with every file in the repo, and a tab for pull requests.

## Credits

Syntax colors come from [highlight.js](https://highlightjs.org) 11.12.0, vendored in
`mods/reviewer/vendor/` with its BSD-3-Clause license.

## License

MIT. See `LICENSE`.
