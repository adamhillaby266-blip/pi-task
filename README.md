# Pi Task

[简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [Русский](./README.ru.md)

> **Turn an AI conversation into work you can resume, review, and accept.**

Pi Task is a local, conversation-first task workspace built on [Pi](https://github.com/badlogic/pi-mono). Choose one working directory, talk naturally, and formalize only the work that needs a durable plan, execution history, evidence, and human acceptance.

**Conversation first · One working directory · Human-controlled · Runs locally from source**

![Pi Task turns a conversation into a reviewable task agreement](./docs/assets/pi-task-task-framing.png)

*An isolated fictional workspace in the Chinese UI locale. It contains no real session, task, credential, or local path.*

## Why Pi Task

A chat transcript can explain what happened, but delivery work also needs clear answers to harder questions:

- What exactly are we trying to deliver?
- Which sources and constraints are authoritative?
- What is blocked, interrupted, or waiting for a decision?
- What changed, how was it verified, and what remains uncertain?
- Who decides that the work is actually done?

Pi Task keeps those answers connected to the original Pi conversation instead of moving work into a separate project-management system.

```text
Choose a working directory
→ Talk naturally
→ Save or confirm a task agreement when the work deserves one
→ Execute, pause, decide, or recover in the same conversation
→ Review artifacts and verification evidence
→ Accept the work or send it back
```

Simple questions stay simple conversations. A Task appears only when durable delivery is useful.

## What makes it different

- **One working directory:** conversation, files, loaded rule sources, and the Task Board follow the same local scope.
- **Tasks emerge from conversation:** no Project setup or long task form is required before you can start thinking.
- **Human gates stay real:** choosing an option answers a question; it does not silently start a Run or authorize an external effect.
- **Task and Run are separate:** agent streaming is not treated as business completion. Only a human can accept a Review or complete a Task.
- **Work can recover:** interruption, blocking, cancellation, same-session continuation, artifacts, and review evidence are persisted.
- **Pi remains the center:** session browsing, real-time chat, models, Skills, files, and Git worktrees remain available around the task workflow.

## Start from source

**Prerequisite:** Node.js 22.19.0 or newer.

```bash
git clone https://github.com/adamhillaby266-blip/pi-task.git
cd pi-task
npm ci --include=dev --ignore-scripts
npm run dev
```

Open <http://127.0.0.1:30142>.

Pi Task is currently a developer-source release, not an end-user installer or npm package. Do not use an inherited `npx`, global-install, or `pi-web` command to run it. For isolated development, validation commands, and the macOS local-build path, read [Developing Pi Task from source](./docs/development.md).

## Current boundary

Pi Task is designed for local developer use.

- The source launcher accepts only loopback hosts (`127.0.0.1` or `localhost`).
- LAN exposure, reverse proxies, hosted deployment, Docker images, npm publication, signed desktop installers, automatic updates, and GitHub Releases are not supported.
- Do not run Pi Web and Pi Task against the same active Pi session at the same time.
- Multi-Agent delegation is not enabled by default; the current product path remains one conversation with explicit human decisions.

## Local data and model privacy

The application and task state are local, but model requests follow the provider configured in Pi.

| Data | Default location | What to know |
| --- | --- | --- |
| Pi sessions, model settings, and authentication | `~/.pi/agent` | Pi Task reads local Pi state; actions you invoke can update it. |
| Pi Task data | `~/.pi-task/pi-task.sqlite` | Task, Run, artifact, Review, and event state is stored in local SQLite. Stop Pi Task before a manual backup. |
| Working-directory files | Selected working directory and restored Session directories | Prompt and tool activity may expose selected content to the configured model provider. Follow that provider's data policy. |

For experiments and tests, keep `HOME`, `TMPDIR`, `PI_CODING_AGENT_DIR`, and `PI_TASK_DATA_DIR` under the ignored `.runtime/` directory. Never use real credentials, unpublished material, or company data in fixtures.

`.gitignore` is a guardrail, not a secret-management system. Before committing, inspect `git status` and never add Pi data, SQLite files, session JSONL, environment files, logs, or private keys.

## Development checks

After installing dependencies:

```bash
node_modules/.bin/tsc --noEmit
npm run lint
node --test lib/*.test.mjs components/tasks/*.test.mjs
```

Do **not** run `next build` or `npm run build` during normal development. It writes `.next/` and can interfere with `npm run dev`. The isolated macOS build flow is documented separately and is not a package-release process.

## Documentation

- [Product direction and boundaries](./docs/product/pi-task-product-boundary.md)
- [Conversation-to-task design](./docs/architecture/task-framing.md)
- [Developer source workflow](./docs/development.md)
- [Task and Run architecture](./docs/architecture/gate-d.md)
- [macOS local delivery](./docs/architecture/gate-e-macos-local.md)
- [macOS Dock/PWA local use](./docs/macos-dock-pwa.md)
- [Git worktrees](./docs/worktrees.md)
- [Contributing](./CONTRIBUTING.md) · [Security](./SECURITY.md)

## License and provenance

Pi Task is derived from [Pi Web](https://github.com/agegr/pi-web) v0.8.6 under the MIT License. The upstream provenance and import boundary are recorded in [UPSTREAM.md](./UPSTREAM.md); the inherited MIT notice is retained in [LICENSE](./LICENSE).

Issues are enabled. Discussions are disabled. Focused pull requests should begin with an Issue, and security reports should use GitHub Private Vulnerability Reporting.
