# opencode-user-edits

Let the agent know what you edited.

An OpenCode V2 plugin that tells the agent which files changed outside the agent between turns.

When a session's execution ends, the plugin snapshots the Git worktree. When you send the next prompt, it snapshots
again and attaches the difference to your message.

## What the agent receives

- The full diff when it is short (at most 50 lines and 4000 characters).
- Otherwise a list of changed files with their status (`A` / `M` / `D` / `T`), up to 50 files.

When HEAD moved, for example after a commit or a branch switch, the agent also learns the old and new commits.

## Storage

Snapshots live in `$XDG_DATA_HOME/opencode/user-edits` (default `~/.local/share/opencode/user-edits`). They
respect `.gitignore`, share objects with your repository, and leave your repository's index, refs, and objects
untouched. A session's snapshots are cleaned up after the session is deleted.

## Limitations

- Diffs are computed with Git, so the plugin works only in Git repositories.
- Edits made while the agent is running are not reported.
- Edits from another session in the same worktree, or from background processes the agent started, are reported as
  your edits.
- Changes inside submodules show only as a changed submodule commit.
