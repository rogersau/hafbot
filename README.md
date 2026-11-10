# HAF Bot

HAF Bot is an MIT-licensed Discord community application with moderation, tickets, player links,
community automation and an administrator dashboard. Self-hosted installations use their own
Discord application, PostgreSQL and private object storage. Set `HAF_DEPLOYMENT_MODE=self-hosted`
to enable core feature capabilities without a hosted HAF subscription. Existing resource, provider,
Discord and abuse limits still apply.

This is the initial public source release of [rogersau/hafbot](https://github.com/rogersau/hafbot).
The hosted service at [hafbot.xyz](https://hafbot.xyz/) is separately operated.

The source build, PostgreSQL contracts and local container readiness/migration path are validated.
A fresh independent live Discord/OAuth, Tunnel/private-object and end-to-end backup/restore
rehearsal has not been completed for this release. Verify your own credentials, operator policies
and integrations before inviting users. This release provides a build-from-source path; it does
not publish or grant access to the hosted service's private container images or infrastructure.
See [initial release notes](RELEASE_NOTES.md) for the validation scope and live-test limits.

## Run your own installation

Follow [Self-host with Docker](docs-site/self-hosting.md). The generic stack is in `infra/self-host`:

```sh
cd infra/self-host
cp .env.example .env
chmod 600 .env
# Replace the Discord, auth/signing, database and private object-store placeholders.
docker compose -f compose.yaml -f compose.source.yaml build app
docker compose -f compose.yaml -f compose.source.yaml up -d --wait
```

The guide covers staged activation, Discord command registration, Cloudflare Tunnel, private R2
storage, updates and backups. [Deploy with Cloudflare](docs-site/deploy-cloudflare.md) explains the
current Node/PostgreSQL boundary. A fully Cloudflare-hosted release is not currently supplied.
No maintainer registry, database, Discord token or cloud account is needed to build this project.
A working installation needs the operator's own credentials for the services it uses.

## Develop and validate

Use the Node engine and pnpm version in `package.json` and Docker Compose.

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm build
pnpm typecheck
pnpm test
pnpm docs:build
```

The application tests use fictional fixtures and local boundary fakes. For the PostgreSQL contract
suite, supply `TEST_POSTGRES_URL` for a disposable local database ending in `_test`, then run
`pnpm test:postgres`. These tests reset that test schema. The public CI creates its own temporary
PostgreSQL service and runs on fresh GitHub-hosted runners without deployment credentials.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md), and
[the public CI design](docs/public-ci.md). The compatibility SQLite/D1 schema supports the existing
store test seams; account-specific Worker deployment configuration is intentionally absent.

## License and notices

[MIT](LICENSE). Dependencies and artwork retain their applicable rights and notices; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The source license grants no hosted API account,
provider credential or endorsement for an independently operated deployment.
