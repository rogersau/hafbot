# Contributing to HAF Bot

Search [public issues](https://github.com/rogersau/hafbot/issues) before opening a focused bug or
feature proposal. Use [private vulnerability reporting](https://github.com/rogersau/hafbot/security/advisories/new)
for security reports; see [SECURITY.md](SECURITY.md). Use fictional Guild/member data and redact
credentials, webhook URLs, production logs and private evidence from every report or screenshot.

Read [CONTEXT.md](CONTEXT.md) for vocabulary. Install the pinned pnpm dependency tree, run
`pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm docs:build`.
Runtime/database changes also need `pnpm test:postgres` on a disposable local `_test` database.
Use your own development Discord identity; automated public CI uses no real Discord account.

Keep PRs focused. Aim for a description under 100 words: one or two sentences on the problem and
resulting behaviour, then one validation line. Include details or caveats only when needed for review.
Preserve Discord authorization, tenant boundaries, job/operation identities and secret redaction. Update
the current installation schema directly; this baseline contains no migration or historical
compatibility path. Public CI validates fork PRs on fresh GitHub-hosted runners with read-only
permissions. It has no deployment, cloud provisioning, package publishing or private-network access.

## Merges and releases

Changes to `main` go through a PR with all three required CI checks passing, an up-to-date branch
and resolved conversations. Squash merging is the only allowed merge method; the PR title becomes
the commit title. These protections also apply to administrators. Reviews are welcome but an
approval is not required, so a solo maintainer can merge their own PRs.

Every push to `main` in `rogersau/hafbot` publishes a GitHub release after all validation passes.
The release includes generated notes, a source archive, the exact Linux amd64 container that passed
the smoke test, its image ID and `SHA256SUMS`. Publishing runs with repository write access only
after the read-only build/test jobs succeed. Forks and manual validation runs do not publish.

Versions default to a patch bump. For an intentional minor or major release, include
`[release:minor]` or `[release:major]` in the PR title before squashing. Major takes precedence.
Versions derive from stable tags and first-parent commit titles, so overlapping builds keep unique,
repeatable versions even if they finish out of order. Untagged commits since the preceding release
each count toward the version, including commits predating this automation. Package manifest
versions are not changed automatically.

Main builds are never cancelled by subsequent pushes. Publishing is serialized with GitHub's
`queue: max` (up to 100 waiting jobs). A failed build publishes nothing; after resolving a transient
failure, rerun that main workflow in Actions. A failed publishing job can resume its draft release;
a rerun skips an already published release. Version tags are never moved or deleted, and an older
build finishing later does not replace the newest version as GitHub's latest release.

Unless stated otherwise, contributions are provided under the [MIT license](LICENSE). Preserve
third-party notices. The HAF name and branding must not imply that an independent fork is operated
or endorsed by the official hosted service.
