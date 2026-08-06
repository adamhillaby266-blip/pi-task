# Gate D architecture and opening checklist

## Current anchors

- **Audience:** a local Pi user who starts with a normal Agent conversation and only formalizes work when it becomes multi-step, durable, or reviewable.
- **Goal:** make task creation and recovery usable without requiring the user to understand Task/Run/Session internals.
- **Authoritative sources:** SQLite remains authoritative for Project, Task, Run, Artifact, Review, and Event; Pi Session JSONL remains authoritative for conversation history.
- **Success path:** free conversation → confirm a task contract → bind the existing Session → interrupt one Run → restart safely → continue in the same Session with a new Run → submit Review → human acceptance.
- **Out of scope:** production packaging, scheduling, automatic claiming, multi-Agent execution, analytics, workflow editing, and LAN publication.
- **Gate status:** D1–D3 implementation and acceptance are complete; this is not evidence that production packaging is ready.

## Why Gate D is not packaging yet

Gate C proved the control-plane contract and real-model loop. It did not prove that a normal user can create and recover work without first navigating to a test-oriented board flow. Packaging now would stabilize an incomplete entry and recovery experience.

## Initial gaps (resolved in D1–D3)

1. A free Pi conversation cannot be converted into a Task from the Agent view.
2. Task creation cannot bind an existing persisted Pi Session; binding only occurs after a new task is prepared and started.
3. A restored `ready` Task with an interruption or return note has no direct “continue” action in the conversation header.
4. A failure after StartTask succeeds but before the prompt request begins can leave an active Run until process restart.
5. `waiting_user` is handled by Pi extension UI, but the surrounding Task state can remain visually stale until the Agent turn settles.
6. `blocked`, cancel, reopen, and contract editing are represented in the planned state model but do not yet have complete user paths.
7. Desktop HTML drag-and-drop has domain tests but has not been exercised in a real browser.

## Gate D slices

### D1 — Conversation conversion and interrupted recovery

- Add a low-pressure “整理为任务” action only for persisted conversations that are not already bound to a Task.
- Ask the user to confirm title, goal, acceptance criteria, expected output, and Project.
- Validate server-side that the Session exists, is idle, and its cwd is inside the selected Project root.
- Create the Task as `ready` with `primarySessionId` already bound.
- Reprepare the same Session with Pi Task tools, prefill the controlled task prompt, and wait for explicit user send.
- Add “继续处理” to a restored `ready` Task in the conversation header, preserving `recoveryNote` and the existing Session.
- Compensate a Run if startup succeeded but the browser could not begin the prompt request.

### D2 — Human-input and blocked paths

- Make `waiting_user` authoritative state visible in both conversation and Task detail.
- Preserve the question and answer as explicit Event evidence.
- Add user-controlled block/unblock and cancel paths with required reasons.
- Ensure active Runs converge safely before Task state changes.

### D2 lifecycle contract

- `waiting_user` remains a Run state while the Task remains `in_progress`; the interface must say “等待你决定”, not imply Pi is still autonomously working.
- The Agent’s question and the user’s response are retained as ordered `run.waiting_user` / `run.resumed` events and shown in Task detail.
- Blocking is allowed from `ready` or `in_progress`. An active Run becomes `interrupted`; the Task becomes `blocked`; the reason is retained as the visible blocking note.
- Unblocking requires a resolution note and returns the Task to `ready`; that note becomes context for the next Run.
- Canceling is allowed from every non-terminal Task state. An active Run becomes `canceled`; the Task becomes `canceled`; the reason remains in immutable Event history rather than appearing as a misleading “continue” note.
- For block/cancel of an active Run, the server first suspends the Run capability and requests Pi abort. If abort fails, it restores the capability and does not change Task state. Once abort succeeds, the state transition prevents a late Agent Review from being accepted.

## D2 implementation and acceptance

Implemented:

- `waiting_user` / resume Event evidence, user-controlled block, unblock, and cancel transitions, and their required-reason UI are complete.
- Blocking or canceling an active Run suspends the Task capability, aborts Pi, and writes the SQLite transition only after abort succeeds.
- `scripts/run-gate-d-conversation-smoke.sh` covers the isolated no-model lifecycle path; `scripts/view-gate-d-lifecycle.sh` creates the separate browser fixture.
- `scripts/run-gate-d-external.sh` runs the controlled real-model vertical check with a masked, environment-only MiniMax key; its runtime result contains no credential or user-answer plaintext.

Verified:

- TypeScript, ESLint, 261 regular tests, four workspace-compatible project-trust tests, and the D2 no-model smoke path passed during implementation.
- macOS real-browser acceptance passed on 2026-08-05 using the isolated fictional fixture. The user completed `ready → blocked → ready → canceled` through “标记阻塞”, “解除阻塞”, and “取消任务”, with required reasons at each step and without sending a task prompt.
- The final task detail showed the status/execution evidence and recorded reasons. Buttons were not crowded or obscured; the blocking and recovery information was legible; canceled Tasks no longer offered “继续处理”; and narrow-window inspection did not truncate reasons or controls.
- Real-model vertical acceptance passed on macOS on 2026-08-05 in isolated runtime `.runtime/external-gate-d-20260805-215735`, using `minimax-cn / MiniMax-M3` and fictional data only:
  - a real free conversation was converted into a bound Task; its primary Session was reused, the Agent called `read_task` and `request_task_input`, the user replied, the same Run created and reread `decision.md`, submitted a Review, and the user accepted it. SQLite records `Run=succeeded`, `Review=accepted`, `Task=done`, and ordered `run.waiting_user → run.resumed → review.submitted → review.accepted` evidence;
  - a separate real Session/Run invoked `read_task` and a pending long-running `bash` command. The user cancel path then produced `Run=canceled`, `Task=canceled`, no Review, and `run.canceled → task.canceled` evidence. The Session recorded an aborted final assistant turn and an errored Bash result, so the cancellation occurred before a late Review could be submitted;
  - the live run made 11 provider requests in total (82,417 reported tokens including cache reads; USD 0.01362426 reported cost). The isolated `auth.json` was `{}` after shutdown.

D1/D2 acceptance is complete. D3 was scoped separately and is now complete; none of this evidence implies production packaging readiness.

### D3 — Contract maintenance and interaction verification (complete)

- Edit a backlog/ready Task contract with optimistic version checks.
- Make incomplete contracts visibly non-startable instead of failing only after an action.
- Verify desktop drag-and-drop, same-column sorting, and touch fallback in a real browser.
- Keep production packaging as a separate decision after the daily-use path is stable.

## D3 implementation and acceptance

Implemented:

- `TaskStore.updateTaskContract()` and `PATCH /api/tasks/[id]` require the current positive `version`, permit edits only while a Task is `backlog` or `ready`, and append immutable `task.contract_updated` evidence when content changes.
- A `ready` Task cannot be saved with a missing goal, acceptance criteria, or expected output; an incomplete `backlog` Task remains valid until the human completes it.
- The board shows missing contract fields on cards and in Task detail, disables ready/Pi actions until the contract is complete, and provides an editor that reports the current version for concurrent-edit recovery.
- Native desktop drag-and-drop continues to handle queue moves and same-column placement. Detail views provide explicit `移到待办 / 移回积压 / 上移 / 下移` controls for touch or no-drag environments.
- `scripts/seed-gate-d-d3-browser.mjs` and `scripts/view-gate-d-d3.sh` create an isolated fictional browser fixture without a model credential.

Verified:

- `node_modules/.bin/tsc --noEmit`, `npm run lint`, and `node --test lib/*.test.mjs components/tasks/*.test.mjs` passed on 2026-08-05; the regular suite reported 207 passing tests.
- Final no-model smoke runtime `.runtime/gate-d-d3-final-smoke-20260805-223927` seeded the fictional fixture, compiled the browser page (`200`), accepted a valid contract PATCH (`200`), rejected a stale version (`409`), rejected an incomplete ready contract (`400`), and retained isolated `pi/auth.json` as `{}`.
- macOS real-browser acceptance passed on 2026-08-05 with the fictional fixture. The user completed contract editing and completeness gating, desktop same-column sorting, and the explicit queue-move fallback controls, then confirmed the full interaction path was smooth. The final visual review also confirmed the first-card hover clearance and softened resting card outlines.
- No D3 model request was made and no production build/package step was run.

## D1 invariants

1. One primary Task per Pi Session remains enforced by SQLite.
2. Converting a conversation never sends a model prompt automatically.
3. The browser may request a Session binding, but the server verifies Session existence, cwd containment, and idle state.
4. A creation failure does not mutate the Session.
5. A preparation failure may leave a valid bound `ready` Task, but the UI must say that the Task was saved and provide a retry path.
6. Continuing an interrupted Task creates a new Run only when the user sends the prefilled prompt.
7. The Agent still cannot accept Review or mark the Task done.

## D1 acceptance checks

- A persisted free Session shows “整理为任务”; a bound Session does not.
- Required contract fields are confirmed before a `ready` Task is created.
- The created Task can be found immediately through `GET /api/tasks?sessionId=...`.
- The same Session reloads with `read_task`, `request_task_input`, and `submit_task_review` available.
- Closing the dialog or preparation failure never sends a model request.
- A `ready` Task with `recoveryNote` shows the reason and a direct same-Session continue action.
- Failure before prompt dispatch produces `Run=interrupted`, `Task=ready`, no active Run, and a visible recovery note.
- TypeScript, ESLint, domain tests, and development-mode page compilation pass under isolated runtime directories.

## D1 implementation status

Implemented:

- persisted free conversations expose a restrained “整理为任务” action only after the Session-to-Task lookup completes;
- the confirmation dialog requires Project, title, goal, acceptance criteria, and expected output;
- the create API verifies persisted Session identity, idle state, and Project-root containment before storing `primarySessionId`;
- a created Task immediately resolves through the same Session and prepares Pi Task tools without starting a Run or sending a prompt;
- restored `ready` Tasks expose “继续处理” in the conversation header and preserve the recovery reason;
- a Run created before event-stream/prompt dispatch is compensated back to `ready/interrupted`;
- Task API errors use a cross-bundle brand so Turbopack module duplication cannot turn a domain 409 into an internal 500;
- `scripts/run-gate-d-conversation-smoke.sh` reproduces the no-model conversion and interrupted-recovery path in an isolated runtime;
- `scripts/view-gate-d-conversation.sh` creates a separate free-conversation fixture for real-browser inspection without a model credential.

Verified:

- TypeScript and ESLint pass;
- 257 upstream/Pi Task tests plus four workspace-compatible project-trust tests pass;
- development-mode page compilation returns 200;
- isolated smoke runtime `.runtime/gate-d-conversation-20260805-201700` reused one Session, loaded all three Task tools, created no Run before send, rejected missing/out-of-root/duplicate Session bindings, interrupted one started Run, and prepared the same Session again with `Task=ready`;
- isolated `auth.json` remained `{}` and no model prompt was sent.
- Real-browser D1 entry acceptance on macOS, using isolated fixture `.runtime/gate-d-browser-20260805-202512`:
  - the free conversation opened the complete “把当前对话整理为任务” form with an explicit new-project choice, seeded title and goal, and human-editable acceptance/output fields;
  - after user confirmation, the same conversation displayed a `ready` Task strip with “继续处理” and “查看任务” actions;
  - the controlled task context was prefilled in the composer and remained unsent;
  - read-only SQLite inspection confirmed one `ready` Task bound to the fixture Session, `activeRunId=null`, no Run rows, only `task.created`, and one original user message in the Session file;
  - the browser test used deliberately arbitrary acceptance/output text in an ignored fictional runtime only.

Not yet verified:

- the interruption-specific recovery note styling in a real browser; its state and same-Session reprepare path are covered by the isolated smoke test;

## Open questions after D1

- Whether contract drafting should later use an optional model-assisted summary. D1 deliberately uses the existing Session title/first message as a draft and requires human confirmation, avoiding hidden cost and fabricated acceptance criteria.
- Whether one Session should ever hold multiple primary Tasks. D1 keeps the proven one-Session/one-primary-Task invariant.
- Touch devices use explicit queue controls as the D3 fallback; drag emulation is deliberately not added.
