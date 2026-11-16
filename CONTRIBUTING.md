# Contributing to HAF Bot

Keep changes focused. Use a clear PR title, briefly explain the problem and the fix, and say how you checked it.
A few sentences and a validation line are usually enough.

## Development

Read [CONTEXT.md](CONTEXT.md) for project terminology. Install dependencies with
`pnpm install --frozen-lockfile` and run checks relevant to your change:

- `pnpm lint` and `pnpm format:check`
- `pnpm build`, `pnpm typecheck` and `pnpm test`
- `pnpm docs:build` for documentation changes
- `pnpm test:postgres` for runtime/database changes, using a disposable local `_test` database

CI runs the full checks. Use fictional data and your own development Discord identity.
Preserve Discord authorization, tenant boundaries and secret redaction. Update the current
installation schema directly; this baseline has no historical migration path.

## Merges and releases

Merge PRs into `main` by squashing, after CI passes and conversations are resolved. The branch
must be up to date. These rules apply to admins too; another person's approval is not required.

Each successful `main` build publishes a release with notes, source, the tested Linux amd64 Docker
image and checksums. Versions default to patch; put `[release:minor]` or `[release:major]` in the PR
title when needed. Existing untagged commits also count toward the first automated version.

If a workflow fails, fix the cause and rerun it in Actions. Publishing can resume a draft and skips
an already published release. Existing version tags are never moved.

Report vulnerabilities privately through [SECURITY.md](SECURITY.md). Keep credentials, production
logs and private member data out of issues and PRs. Contributions use the [MIT license](LICENSE);
preserve third-party notices and do not imply that an independent fork is the official service.
