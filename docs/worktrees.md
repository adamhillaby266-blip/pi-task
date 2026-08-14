# Worktrees in Pi Task

Pi Task can show all Git worktrees for one repository in the sidebar. Use this when you want separate checkouts for different branches while keeping related sessions easy to find.

## When the Worktree Control Appears

The worktree switcher appears below the working-directory selector when the selected directory is a Git repository root.

It is hidden when:

- The selected directory is not a Git repository.
- The selected directory is inside a repository, but not the repository root.
- Git cannot read the repository's worktree list.

If you are inside a repo subdirectory, use **Open repository root** below the working-directory selector before managing worktrees.

## Switching Worktrees

Use the worktree switcher to choose the working directory Pi Task should use for new work.

Switching worktrees affects:

- New sessions started from the sidebar.
- The file Explorer.
- File mentions inserted from the Explorer.

Existing sessions remain grouped internally by repository. Opening one moves the visible working directory back to that session's checkout.

## Creating a Worktree

Choose `New worktree...` from the worktree menu and enter a branch name.

Pi Task creates the checkout at:

```text
<repo>-worktrees/<branch>
```

For example, if the main checkout is:

```text
~/Projects/pi-task
```

and you create branch `codex/worktree-help`, the worktree is created under:

```text
~/Projects/pi-task-worktrees/codex-worktree-help
```

If the branch already exists, Pi Task adds a worktree for that branch. If it does not exist, Pi Task creates the branch from the current `HEAD`.

## Removing a Worktree

Use the remove button next to a non-main worktree to remove that checkout.

Removing a worktree does not delete:

- The Git branch.
- Pi Task session history.
- The main checkout.

If the worktree has uncommitted or untracked files, Git refuses the removal. Pi Task then offers a force remove action. Force removal discards the uncommitted files in that checkout, so use it only when you no longer need those changes.

## Sessions and Worktrees

Pi Task internally groups sessions by repository root, so sessions from the main checkout and linked worktrees appear together without exposing a separate Project selector.

Each session still remembers the working directory it was created with. That means:

- A session started in a worktree continues to use that worktree path.
- A session started in the main checkout continues to use the main checkout.
- If a worktree has been removed, its old sessions remain visible so you can still find the history.

## Troubleshooting

**I do not see the worktree switcher.**
Select a Git repository root. Non-Git directories and repo subdirectories show a small hint instead of the switcher.

**A branch cannot be added as a worktree.**
Git allows a branch to be checked out in only one worktree at a time. Switch to the existing worktree for that branch, or remove it first.

**A removed worktree still shows up in Git.**
Git can keep prunable worktree records after a checkout disappears. Pi Task filters those out of the switcher.

**The Explorer shows a different branch than the open chat.**
The Explorer follows the selected worktree. The chat follows the opened session. Click the session again to move the sidebar back to that session's checkout.
