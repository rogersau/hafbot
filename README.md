# HAF Bot

HAF Bot is an MIT-licensed Discord community application with moderation, tickets, player links,
community automation and an administrator dashboard. Self-hosted installations use their own
Discord application, PostgreSQL and private object storage. Set `HAF_DEPLOYMENT_MODE=self-hosted`
to enable core feature capabilities without a hosted HAF subscription. Existing resource, provider,
Discord and abuse limits still apply.

This is the public source repository of [rogersau/hafbot](https://github.com/rogersau/hafbot).
The hosted service at [hafbot.xyz](https://hafbot.xyz/) is separately operated.

The public codebase targets fresh installations. Startup initializes an empty database from
[`schema/postgres.sql`](schema/postgres.sql); no private migration history is included. Private-service customers, historical price
cohorts and previously issued Discord controls have no compatibility contract here. Configure
current provider prices and publish controls using your installation's own signing secret.

The source build, PostgreSQL contracts and local container readiness and fresh-initialization path are validated.
A fresh independent live Discord/OAuth, Tunnel/private-object and end-to-end backup/restore
rehearsal has not been completed for this release. Verify your own credentials, operator policies
and integrations before inviting users. Build from source or download the tested Linux amd64
container archive from an automated [GitHub release](https://github.com/rogersau/hafbot/releases).
The hosted service's private container images and infrastructure remain separately controlled.
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
[the public CI design](docs/public-ci.md). Production code uses native PostgreSQL stores.
SQLite stores and schema fixtures live under `test/support` for isolated service tests; they are not
an installation path. See the [architecture audit](docs/architecture-audit.md) for the runtime
boundaries and clean-slate decisions.

## License and notices

[MIT](LICENSE). Dependencies and artwork retain their applicable rights and notices; see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The source license grants no hosted API account,
provider credential or endorsement for an independently operated deployment.
