# Contributing to Pi Task

Pi Task is an early, local developer-source project. Focused reports and pull requests are welcome, but maintainers do not promise a review timeline or acceptance.

## Start with an issue

GitHub Issues are the place to report reproducible bugs and propose scoped changes. GitHub Discussions are intentionally not enabled at this stage.

Before opening a substantial pull request, open an Issue first and describe the user problem, expected behavior, scope, and validation plan. This avoids spending effort on a change that is outside the current product boundary.

Do not include credentials, session JSONL, SQLite databases, proxy URLs containing authentication, customer/company data, unpublished material, or screenshots with personal data in an Issue or pull request.

## Development expectations

1. Read [the source-development guide](./docs/development.md) and keep validation data under `.runtime/`.
2. Keep Pi Task local-only. Do not add LAN exposure, reverse-proxy guidance, hosted deployment, npm publication, or desktop packaging without an explicit product decision.
3. Preserve Task/Run separation: an Agent must not accept a Review or mark a Task complete.
4. Make focused changes and include tests for behavior changes.
5. Before submitting, run the relevant checks:

   ```bash
   node_modules/.bin/tsc --noEmit
   npm run lint
   node --test lib/*.test.mjs components/tasks/*.test.mjs
   git diff --check
   ```

   In a parent workspace that injects `.agents/skills` into temporary fixtures, use the compatibility guidance in `docs/development.md` for the known project-trust test limitation.

## Pull requests

- Keep one problem per pull request.
- Explain the user-visible behavior, security/data effect, and how it was verified.
- Do not include generated `.next/`, `.runtime/`, `node_modules/`, or local user data.
- Maintainers may request a narrower scope, tests, documentation changes, or close a pull request that is outside the current roadmap.

For security-sensitive issues, do not open a public Issue. Follow [SECURITY.md](./SECURITY.md).
