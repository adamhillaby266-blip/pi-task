# Developing Pi Task from source

Pi Task is a local, developer-source project. It is not an npm-distributed application, a signed desktop app, or a hosted service.

## Prerequisites

- Node.js 22.19.0 or newer;
- a source checkout of this repository;
- a local Pi setup only if you intentionally want to inspect or use existing Pi data.

The documented local-delivery acceptance was performed on macOS arm64. The normal source workflow is Node/Next.js based, but deployment support outside that documented macOS path is not established.

## Install and run

From a fresh source checkout:

```bash
npm ci --include=dev --ignore-scripts
npm run dev
```

Open <http://127.0.0.1:30142>. The supplied `dev` and `start` scripts bind to loopback, and the source launcher rejects non-loopback `--hostname` and `PI_WEB_HOSTNAME` values. Do not expose Pi Task through a LAN address, reverse proxy, or public host.

`npm ci --include=dev --ignore-scripts` uses the committed lockfile and deliberately avoids lifecycle scripts. Do not replace it with an inherited Pi Web global install or `npx` command.

## Use an isolated runtime for experiments

A normal local launch can access existing Pi and Task data. For tests, demos, or any work that does not specifically require existing local data, isolate every mutable path under the ignored `.runtime/` directory:

```bash
runtime_dir="$PWD/.runtime/manual-dev"
mkdir -p "$runtime_dir/home" "$runtime_dir/tmp" "$runtime_dir/pi" "$runtime_dir/task-data"

export HOME="$runtime_dir/home"
export TMPDIR="$runtime_dir/tmp"
export PI_CODING_AGENT_DIR="$runtime_dir/pi"
export PI_TASK_DATA_DIR="$runtime_dir/task-data"
export PI_TASK_NEXT_DIST_DIR=".runtime/manual-dev/next"

npm run dev
```

This starts with no real Pi sessions, provider authentication, or Task database. Do not copy real credentials, session JSONL, company material, or unpublished files into the isolated runtime.

To return to normal local data in the same shell, unset the five variables above or open a new terminal.

## Data boundary

| Path or variable | Purpose |
| --- | --- |
| `~/.pi/agent` / `PI_CODING_AGENT_DIR` | Pi sessions, model settings, authentication, Skills, and related Pi state. |
| `~/.pi-task` / `PI_TASK_DATA_DIR` | Pi Task SQLite state; the normal database is `pi-task.sqlite`. |
| `.runtime/` | Ignored isolated fixtures, test output, and staged build output. It is not a backup of user data. |
| `.next/` | Generated Next.js output. It is replaceable program output, not user data. |

Pi Task can read local Sessions and files in the selected working directory. When a user sends an agent prompt, configured model providers may receive the prompt and relevant tool results. Keep the workspace local, use the principle of least access, and follow the provider's data policy.

Do not operate Pi Web and Pi Task concurrently on the same active Pi session.

## Validate changes

Use the isolated environment above, then run the applicable checks from the repository root:

```bash
node_modules/.bin/tsc --noEmit
npm run lint
node --test lib/*.test.mjs components/tasks/*.test.mjs
```

If an enclosing workspace injects `.agents/skills` into every temporary project fixture, the `clean projects stay on the normal trusted load path` assertion will correctly see that fixture as non-clean. In that harness, verify the remaining project-trust coverage with:

```bash
node --test --test-name-pattern='project extensions|reload resolver|all project resource|trust API' lib/project-trust.test.mjs
```

Some focused scripts create their own isolated runtime under `.runtime/`. Read the script before running it; scripts that can make a real model request or promote a build require an explicit human decision.

Never run `next build` or `npm run build` as a routine development check. It writes the default `.next/` directory and can disrupt `npm run dev`.

## macOS production-style build boundary

The only documented production-style build is the macOS E2 flow:

```bash
./scripts/run-macos-local-build.sh
```

It is macOS-only, requires already-installed dependencies, and builds/tests inside `.runtime/` without using real Pi data. It does **not** publish anything and does not promote the build to `.next/`.

The separate E3 promotion step can replace `.next/` and then launch against shared local data. It must only be used after reviewing [Gate E — macOS local delivery](./architecture/gate-e-macos-local.md), confirming there is no active Run, and making an explicit human decision. The installed-service upgrade path also stops the service, creates a consistent Task SQLite backup under `~/.pi-task-backups/`, and proves the schema migration on a separate copy before promotion; do not bypass that preflight when a release changes Task schema. For day-to-day Dock/PWA use after a verified build, see [macOS Dock/PWA local use](./macos-dock-pwa.md).

## Before committing

- Inspect `git status --short` and `git diff --check`.
- Keep `HOME`, `TMPDIR`, `PI_CODING_AGENT_DIR`, and `PI_TASK_DATA_DIR` isolated for validation.
- Never commit credentials, local Pi state, Task SQLite files, session JSONL, proxy configuration, logs, screenshots containing personal data, or build output.
- Treat `.gitignore` as a safety net, not proof that a file is safe to share.

For the product architecture, read [Gate D](./architecture/gate-d.md). For a future public-source repository, use [the GitHub source-publication checklist](./release.md) and obtain explicit approval before any external action.
