# Pi Task

[简体中文](./README.zh-CN.md) · [日本語](./README.ja.md) · [Русский](./README.ru.md)

> A local, source-only task workspace for developers who use [Pi](https://github.com/badlogic/pi-mono). It keeps the Pi conversation at the center while adding durable Tasks, Runs, artifacts, review, and human acceptance.

Pi Task is an early developer-source release, not a consumer installer. Gate D daily-use flows and the Gate E macOS local-delivery path have recorded acceptance, but packaging, signed apps, automatic updates, and hosted deployment are deliberately out of scope.

## What it does

- Turns a persisted Pi conversation into a task with a human-confirmed contract.
- Keeps Task and Run lifecycles separate from agent streaming, so only a human can accept a Review or complete a Task.
- Supports interruption, blocking, cancellation, same-session recovery, artifacts, and review evidence.
- Provides local Pi session browsing, real-time chat, model and Skill controls, file preview, and Git worktree switching.

## Supported boundary

Pi Task is for local developer use only.

- The source launcher accepts only loopback hosts (`127.0.0.1` or `localhost`); documented development and macOS paths use `127.0.0.1:30142`.
- LAN exposure, reverse proxies, internet hosting, Docker images, npm publication, desktop installers, and GitHub Releases are not supported.
- Do not run Pi Web and Pi Task against the same active Pi session at the same time.
- Pi Task may call the model provider configured in your local Pi installation when you send a prompt. Treat prompts, tool results, and files from the selected working directory according to that provider's data policy.

## Start from source

**Prerequisite:** Node.js 22.19.0 or newer.

```bash
git clone <repository-url> pi-task
cd pi-task
npm ci --include=dev --ignore-scripts
npm run dev
```

Open <http://127.0.0.1:30142>. The repository is not an end-user npm package: do not use an inherited `npx`, global-install, or `pi-web` command to run Pi Task.

For isolated development, validation commands, and the macOS build boundary, read [Developing Pi Task from source](./docs/development.md).

## Local data and safety

| Data | Default location | What to know |
| --- | --- | --- |
| Pi sessions, model settings, and authentication | `~/.pi/agent` | Pi Task reads local Pi state; session-management and model/auth actions can write local Pi data when you invoke them. |
| Pi Task data | `~/.pi-task/pi-task.sqlite` | SQLite WAL/SHM sidecars may exist while the app is running. Stop Pi Task before making a manual backup. |
| Working-directory files | Selected working directory and restored Session directories | File access follows the local directory/Session context. An agent can only be trusted with files you are willing to expose to its configured provider. |

For experiments and tests, set `HOME`, `TMPDIR`, `PI_CODING_AGENT_DIR`, and `PI_TASK_DATA_DIR` to directories under the ignored `.runtime/` directory. Never use real credentials, unpublished material, or company data in fixtures.

`.gitignore` is a guardrail, not a secret-management system. Before committing, inspect `git status` and never add Pi data, SQLite files, session JSONL, environment files, logs, or private keys.

## Development checks

Run these from the repository root after installing dependencies:

```bash
node_modules/.bin/tsc --noEmit
npm run lint
node --test lib/*.test.mjs components/tasks/*.test.mjs
```

Do **not** run `next build` or `npm run build` during normal development. It writes `.next/` and can interfere with `npm run dev`. The isolated macOS E2 build flow is documented separately and is not a package-release process.

## Documentation

- [Developer source workflow](./docs/development.md)
- [Gate D architecture and verified scope](./docs/architecture/gate-d.md)
- [Gate E — macOS local delivery](./docs/architecture/gate-e-macos-local.md)
- [macOS Dock/PWA local use](./docs/macos-dock-pwa.md)
- [GitHub source-publication checklist](./docs/release.md)
- [Git worktrees](./docs/worktrees.md)
- [Internationalization](./docs/i18n.md)

## License and provenance

Pi Task is derived from [Pi Web](https://github.com/agegr/pi-web) v0.8.6 under the MIT License. The upstream provenance and import boundary are recorded in [UPSTREAM.md](./UPSTREAM.md); the inherited MIT notice is retained in [LICENSE](./LICENSE).

The first public-source defaults are: current MIT text and upstream attribution retained; Issues enabled; Discussions disabled; focused pull requests accepted after an Issue; and private vulnerability reporting through GitHub. Repository ownership and the public source snapshot are still confirmed at publication time. See [the source-publication checklist](./docs/release.md), [CONTRIBUTING.md](./CONTRIBUTING.md), and [SECURITY.md](./SECURITY.md).
