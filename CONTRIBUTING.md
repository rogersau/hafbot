# Contributing to HAF Bot

Search [public issues](https://github.com/rogersau/hafbot/issues) before opening a focused bug or
feature proposal. Use [private vulnerability reporting](https://github.com/rogersau/hafbot/security/advisories/new)
for security reports; see [SECURITY.md](SECURITY.md). Use fictional Guild/member data and redact
credentials, webhook URLs, production logs and private evidence from every report or screenshot.

Read [CONTEXT.md](CONTEXT.md) for vocabulary. Install the pinned pnpm dependency tree, run
`pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm typecheck`, `pnpm test` and `pnpm docs:build`.
Runtime/database changes also need `pnpm test:postgres` on a disposable local `_test` database.
Use your own development Discord identity; automated public CI uses no real Discord account.

Keep PRs focused and explain observed behaviour, the change and meaningful validation. Preserve
Discord authorization, tenant boundaries, job/operation identities and secret redaction. Update
the current installation schema directly; this baseline contains no migration or historical
compatibility path. Public CI validates fork PRs on fresh GitHub-hosted runners with read-only
permissions. It has no deployment, cloud provisioning, package publishing or private-network access.

Unless stated otherwise, contributions are provided under the [MIT license](LICENSE). Preserve
third-party notices. The HAF name and branding must not imply that an independent fork is operated
or endorsed by the official hosted service.
