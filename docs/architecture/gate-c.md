# Gate C architecture contract

## Product center

Pi conversation is the primary user experience. Tasks are a durable control protocol and a connected view, not a separate project-management product.

## Source of truth

- SQLite: Project, Task, Run, Artifact, Review, Event.
- Pi session JSONL: conversation and tool-call history.
- Association: stable `sessionId`; neither store rewrites the other's format.

## Core invariants

1. A Task has at most one active Run.
2. `in_progress` requires an active `starting`, `running`, or `waiting_user` Run.
3. Only an Agent capability bound to the active Run can submit a Review.
4. Only a browser user action can accept a Review and move a Task to `done`.
5. A returned Task goes to `ready`; the next user send creates a new Run in the same primary Session.
6. Unknown active Runs after process restart converge to `interrupted`; their Tasks return to `ready` with recovery evidence.
7. Artifacts must resolve to existing files inside the registered Project root.

## Gate C scope

Implement one real vertical path:

```text
backlog → ready → in_progress → in_review → ready → in_progress → in_review → done
```

The path uses one Project, one Task, one primary Pi Session, two Runs, one real file Artifact, one return request, and one human acceptance.

Out of scope: automation, scheduling, multi-Agent execution, worktree creation, task relationships, analytics, workflow editors, LAN mode, and production packaging.
