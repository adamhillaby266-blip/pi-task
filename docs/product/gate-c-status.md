# Gate C implementation status

> **后续状态：**Gate D 已完成，浏览器拖拽与合同维护已验收；当前本机交付准备见 [`../architecture/gate-e-macos-local.md`](../architecture/gate-e-macos-local.md)。本文件保留 Gate C 的历史证据。

## Completed

- Pi Web v0.8.6 imported as an auditable MIT baseline.
- Pi Task product metadata and local-only development defaults.
- SQLite records for Project, Task, Run, Artifact, Review, and Event.
- Task/Run state separation, optimistic versions, one-active-Run constraint, artifact root validation, return, acceptance, and restart reconciliation.
- Horizontal seven-column task view inside the Agent application shell.
- Real project/task creation, queue drag-and-drop, task details, artifacts, Run history, Review history, return, and acceptance APIs.
- “在对话中处理” prepares a real Pi Session but keeps the Task in `ready` until the user sends.
- A prepared task Session loads built-in `read_task`, `request_task_input`, and `submit_task_review` tools.
- Sending the prepared prompt calls the server-side StartTask path before the Pi prompt.
- An Agent that settles without submitting Review causes the Run to become `interrupted` and the Task to return to `ready`.
- Startup reconciliation removes phantom running state after process restart.
- The conversation renders a real Review card with Artifact links, verification details, a required return-reason editor, and the user-only acceptance action.
- Selecting or restoring a Pi Session resolves its bound Task from SQLite, so the task status and Review card survive browser or service restarts.

## Verified

- TypeScript typecheck: pass.
- ESLint: pass.
- Upstream and Pi Task automated tests: 254 selected tests pass under the workspace-safe test configuration.
- One upstream “clean project” assertion cannot run as written because every temporary directory under `/workspace` inherits the workspace `.agents/skills`; the other four project-trust tests pass.
- API persistence: Project and Task survive a Next server restart.
- Task Session preparation: Task remains `ready`; Pi Session is created in memory; three Pi Task tools are present among ten active tools.
- Restart failure path: `in_progress/running` becomes `ready/interrupted`, clears `activeRunId`, and records a recovery event.
- Session-to-Task lookup: an active Task is resolved by `primarySessionId`; after restart the same lookup returns its reconciled `ready/interrupted` detail.
- MiniMax M3 external Run on 2026-08-05:
  - selected `minimax-cn / MiniMax-M3` and sent one fictional task prompt;
  - called `read_task`, inspected the empty project, wrote and reread `handoff.md`, verified three required strings, and called `submit_task_review`;
  - recorded one real Artifact, a `succeeded` Run, an `accepted` Review, Task version 4, and final Task status `done`;
  - used five provider requests during the Agent turn; the SDK reported 47,644 total tokens including cache reads and USD 0.0073878 cost;
  - persisted an empty `{}` auth store: no API credential provider was written to disk.
- MiniMax M3 two-Run Gate C closure on 2026-08-05:
  - first Run submitted a real `handoff.md` Review and the user returned it with a concrete compression request;
  - second Run reused Session `019fd155-3800-7804-9dbc-b8e5d01f1427`, called `read_task`, edited and reread the existing file, then submitted a second Review;
  - both Runs are `succeeded`; the first Review is `rejected`, the second is `accepted`, and final Task version 7 is `done` with no active Run;
  - the single Pi Session contains two user turns and both complete tool sequences;
  - a service restart preserved the same Task, two Runs, two Reviews, two Artifact records, and all nine ordered events;
  - the SDK reported 13 provider requests, 158,882 total tokens including cache reads, and USD 0.02257866 cost;
  - the API credential store remained empty after both Runs.
- Real-browser visual acceptance on macOS:
  - the conversation renders the accepted Run 2 Review card, its Artifact link, expandable evidence, and the real `handoff.md` preview without horizontal overflow;
  - the narrow layout hides the sidebar, keeps task navigation readable, and allows the full Review card to scroll above the composer;
  - the task board opens on the most actionable non-empty column, showing the accepted Task in “完成” instead of leaving the user on empty columns;
  - the task detail drawer renders the shared Session’s two succeeded Runs, the real Artifact, the first rejected Review and return reason, and the second accepted Review, with localized status labels;
  - visible product branding and the task-bound Session title consistently use Pi Task and the Task title.

## Not yet verified

- Browser drag-and-drop behavior, including same-column sorting and queue transitions, in a real Chromium/WebKit session.
- Production build and packaging; upstream instructions prohibit running `next build` during active development.

## External model test runner

- `scripts/run-gate-c-external.sh` securely prompts for a MiniMax API Key without echoing or writing it to disk.
- It supports `minimax-cn` and `minimax`, selects `MiniMax-M3`, starts an isolated loopback-only Pi Task runtime, and can execute two fictional Runs in one Task and Session.
- The non-secret result, task database, Pi Session, and fictional artifact remain under the ignored `.runtime/external-gate-c-*` directory for verification.
- Next.js development output is isolated by OS and architecture so macOS does not reuse Linux Turbopack chunks.
- `scripts/view-latest-gate-c.sh` reopens the latest persisted Task and Session without a model credential for browser-only visual inspection.

## Gate C result

The technical and visual Gate C contract is satisfied: one Project, one Task, one persisted Pi Session, two real Runs, one real file, one user return, one second submission, one user acceptance, restart-safe linkage, and real-browser rendering of the conversation, Artifact, board, task detail, Run history, and Review history.

The observed first artifact did not contain the three section labels named by the original scripted return request. The Agent still made a real structural edit and produced different verified content, so the state/Session contract passed; however, the test assertion was weaker than intended. The reusable runner now requests a guaranteed new heading plus a measurable line-count limit.

## Next vertical milestone

Gate D now focuses on conversation-to-task authoring and same-Session recovery; see `docs/architecture/gate-d.md`. Production packaging remains deferred until that daily-use path is stable. Browser drag-and-drop verification remains a separate interaction check rather than reopening the completed Gate C evidence chain.
