# Pi Task — GitHub source-publication checklist

> This document is for a first **source repository** publication. It is not an npm-release, binary-distribution, Docker, or GitHub Release procedure.

Pi Task currently has `"private": true` in `package.json`. Keep it that way unless the maintainer separately approves package publication.

## External-action gate

Do not create a GitHub repository, add a remote, push, upload an artifact, or create a GitHub Release until the maintainer records all of the following:

| Decision | Required value |
| --- | --- |
| GitHub account or organization | Pending: maintainer must identify the target account/organization |
| Repository name | `pi-task` |
| Visibility | `public` |
| First-push scope | Clean source snapshot; do not publish the existing local history |
| License decision | Retain the current MIT text and `UPSTREAM.md` attribution |
| Community policy | Issues enabled; Discussions disabled; focused external pull requests follow an Issue |
| Security-reporting channel | GitHub Private Vulnerability Reporting; see `SECURITY.md` |
| Release artifacts | Source and documentation only |

No value in this table is permission to perform an external action by itself. The maintainer must explicitly authorize the repository creation and first push after the values are decided.

## What a first source publication includes

Candidate scope:

- application source, scripts, tests, public icons, configuration, lockfiles, `README*`, and product documentation;
- `LICENSE` and `UPSTREAM.md`, preserving the Pi Web MIT provenance;
- no executable installer, `.dmg`, signed `.app`, Docker image, npm package, GitHub Release, or model-provider credential.

The repository should describe developer-source use only: Node.js, a terminal, `npm ci`, and local loopback launch. It must not instruct readers to use an inherited Pi Web `npx` command, port `30141`, a global install, LAN exposure, or npm publication.

## Local preflight

Run the checks in an isolated runtime where applicable:

```bash
node_modules/.bin/tsc --noEmit
npm run lint
node --test lib/*.test.mjs components/tasks/*.test.mjs
git diff --check
git status --short
```

Before staging any file, verify all of the following:

- `.gitignore` protects runtime output, `.next/`, environment files, local Pi/Task state, SQLite/JSONL, logs, and private-key formats;
- no tracked content or reachable history contains a credential, local authentication data, unpublished material, or a personal/company-specific path;
- README variants, release guidance, and developer instructions all use `Pi Task`, port `30142`, and the local-only boundary;
- screenshots and other binary assets have been visually reviewed for personal information and third-party rights;
- `LICENSE`, `UPSTREAM.md`, and `package.json` have been reviewed. Do not invent `repository`, `author`, or copyright-holder fields before the maintainer supplies them.

## History is part of the publication

A Git push can expose more than the current worktree. It may reveal prior file versions, author names and email addresses, commit messages, and deleted paths.

Selected approach: **clean source snapshot**. Create a new, reviewed history containing only the approved public tree and an approved author identity; do not publish the existing local `main` history.

Do not rewrite, squash, filter, or delete the existing local Git history. A clean worktree alone does not sanitize prior commits.

## Known release-boundary decisions

- The supported `npm run dev`, `npm run start`, and macOS launcher paths bind to loopback. The source launcher and API host checks reject non-loopback hosts; LAN exposure is unsupported.
- `docs/screenshot2.png` is an inherited Pi Web demonstration image and is no longer linked from the README. It is excluded from the approved public source snapshot while the local source copy remains intact.
- Existing translated READMEs are maintained as Pi Task source-use documentation. The UI itself currently has only the locales documented in `docs/i18n.md`.

## Collaboration and security defaults

- GitHub Issues are enabled for reproducible bugs and scoped proposals.
- GitHub Discussions are disabled initially.
- Focused external pull requests are welcome only after an Issue has aligned the scope; no review or acceptance timeline is promised. See [CONTRIBUTING.md](../CONTRIBUTING.md).
- GitHub Private Vulnerability Reporting is the security channel. Do not put credentials, private session exports, SQLite databases, or confidential project files in public collaboration surfaces. See [SECURITY.md](../SECURITY.md).
- The GitHub owner must still confirm ownership of new Pi Task code alongside the inherited MIT notice before the first commit is authored.

## Approval handoff

When local preparation is complete, ask the maintainer to confirm, in one message:

```text
GitHub account/organization:
Confirm use of GitHub browser/device login for this account (yes/no):
Confirm public repository `pi-task` from the prepared clean source snapshot (yes/no):
Authorize repository creation, private vulnerability reporting, and first push (yes/no):
```

Only after receiving that explicit authorization should a separate, reviewed external-upload plan be executed.
