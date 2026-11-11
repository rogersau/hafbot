---
title: Self-host HAF Bot with Docker
description: Run HAF Bot with your own Discord application, Docker, PostgreSQL, private object storage and a Cloudflare Tunnel.
---

# Self-host HAF Bot with Docker

You can run HAF Bot on a Linux Docker host using your own Discord application, PostgreSQL,
and private S3-compatible or Azure Blob object storage. Cloudflare Tunnel can publish the HTTPS
application without opening an inbound application port on your host.

This initial public release provides reviewed source and a build-from-source Docker path.
No public container image is published with this release. You do not need access to the hosted
service's private registry or infrastructure.

Automated tests cover the source build, PostgreSQL contracts, fresh schema initialization and local container
readiness. A fresh independent live Discord/OAuth installation rehearsal has not been completed.
Live signed ingress, Gateway/commands, Tunnel/private-object integration and an end-to-end
encrypted backup/isolated restore rehearsal remain unverified for an independent installation.
Complete the activation checks below using your own test application and Guild before inviting
users. See [initial release notes](https://github.com/rogersau/hafbot/blob/main/RELEASE_NOTES.md).

Self-hosting means you operate the application, its data, backups, updates, Discord identity and
external accounts. Hosting and provider usage can cost money. The hosted service at hafbot.xyz
remains available for communities that want HAF to operate it.

## Choose a deployment

| Deployment                           | Current status                                | Where the app and database run                                     |
| ------------------------------------ | --------------------------------------------- | ------------------------------------------------------------------ |
| Docker + Cloudflare Tunnel           | Supported starting point                      | Your host runs Node.js and PostgreSQL; Cloudflare provides ingress |
| Docker + another HTTPS reverse proxy | Same runtime; configure your proxy separately | Your host or managed PostgreSQL                                    |
| Entire app on Cloudflare Workers/D1  | Not supplied by this release                  | Requires separate engineering and release validation               |
| Cloudflare Containers                | No deployment adapter supplied                | See [Cloudflare deployment boundaries](/deploy-cloudflare)         |

## Prerequisites

- A Linux host with Docker Engine, Compose v2.24 or later, persistent disk, and outbound Internet
  access to Discord, your object store and Cloudflare. Container validation covers Linux x86-64;
  other architectures need their own source build and validation.
- Access to a reviewed source commit, or a tested image pinned by `@sha256:...`.
- Your own Discord application and a test Guild. Do not use the official hosted bot's credentials.
- A public hostname, such as `bot.example.com`. For Cloudflare Tunnel, use a domain configured in
  your Cloudflare account and a remotely managed tunnel.
- A private object bucket and credentials. R2 works through the S3 adapter; see the
  [R2 configuration](/deploy-cloudflare#use-private-r2-object-storage).

## 1. Configure Discord

Create an application and bot in the Discord Developer Portal. Record these values in your private
environment file:

| Setting                       | Value                                |
| ----------------------------- | ------------------------------------ |
| `DISCORD_APPLICATION_ID`      | Application ID                       |
| `BOT_USER_ID`                 | Bot user ID                          |
| `DISCORD_PUBLIC_KEY`          | Application public key               |
| `DISCORD_BOT_TOKEN`           | Bot token                            |
| `DISCORD_OAUTH_CLIENT_ID`     | OAuth client ID for this application |
| `DISCORD_OAUTH_CLIENT_SECRET` | OAuth client secret                  |

Register `https://bot.example.com/api/auth/callback/discord` as an OAuth redirect. The Gateway
requests the **Server Members** and **Message Content** privileged intents; enable both in the
portal, obtaining Discord approval where required. Install only the permissions your workflows
need, and place the bot's role above roles it manages.

Set the Interactions Endpoint URL to `https://bot.example.com/interactions` after HTTPS is working
and maintenance mode has been switched off in step 5. Discord validates this URL with a signed
request. Use your deployment's `/install` URL to invite your bot.

## 2. Prepare the private environment

From your reviewed source checkout:

```sh
cd infra/self-host
cp .env.example .env
chmod 600 .env
```

Replace every required placeholder. Do not commit `.env` or paste its contents into an issue.

Set `HAF_DEPLOYMENT_MODE=self-hosted` to enable core features without a hosted HAF subscription.
The default is `hosted`; select it explicitly only when operating the subscription service.

Identify your installation with `SELF_HOSTED_OPERATOR_NAME` and set
`SELF_HOSTED_SUPPORT_URL`, `SELF_HOSTED_TERMS_URL` and `SELF_HOSTED_PRIVACY_URL` to your own
HTTPS support and policy documents. These public settings are ignored in hosted mode.
Operator names are limited to 120 characters; URLs must not contain credentials. Policy
URLs must point to actual documents, rather than back to this app's `/terms` or `/privacy`.
If a policy URL is missing, that route returns an operator notice with HTTP 503 until you
configure it. HAF's hosted terms and privacy policy do not describe your installation.

The self-hosted home URL opens your dashboard, and `/help` uses `BETTER_AUTH_URL` for its
dashboard link and your support URL. The Microsoft domain-verification route uses your
configured Xbox/Microsoft application ID, or returns 404 when none is configured. The
shared HAF documentation and upstream release notes describe the software. Before inviting
members, verify your own identity, policies, provider accounts and data-retention settings.

| Settings                                                                                   | Configuration                                                                                                            |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------ |
| `HAF_IMAGE`                                                                                | Tested immutable image digest, or `haf-bot:self-host` for the source-build path                                          |
| `POSTGRES_PASSWORD`, `DATABASE_URL`                                                        | Use the same long URL-safe random password in both; keep host `postgres` and `?sslmode=disable` for the bundled database |
| `PG_ALLOW_INSECURE_DOCKER_NETWORK`                                                         | `true` only for that exact private Docker database configuration                                                         |
| `HAF_PUBLIC_ORIGIN`, `BETTER_AUTH_URL`                                                     | Both `https://bot.example.com`, with no path                                                                             |
| `BETTER_AUTH_SECRET`                                                                       | Independent random secret of at least 32 characters; configure all four OAuth/auth settings together                     |
| `HAF_STATUS_TOKEN`                                                                         | Independent long random token for private operator status                                                                |
| `COMPONENT_ID_SIGNING_SECRET`, `EVIDENCE_MEDIA_SIGNING_SECRET`                             | Separate long random secrets                                                                                             |
| `WEBHOOK_CREDENTIAL_KEY_V1`                                                                | Base64 encoding of exactly 32 random bytes                                                                               |
| `S3_BUCKET_NAME`, `S3_REGION`, `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | Your private object store; do not configure Azure storage at the same time                                               |
| `HAF_ADMIN_GUILD_ID`, `HAF_ADMIN_ROLE_ID`                                                  | Optional private operator Guild and role for `/haf-admin`; use your own IDs                                              |

Generate a separate value with `openssl rand -hex 32` for each application signing/auth secret
and database password. Use `openssl rand -base64 32` for `WEBHOOK_CREDENTIAL_KEY_V1`.
Keep signing/encryption keys in your encrypted backup; generating new ones on every restart breaks
existing signed links or stored credentials.

Leave Gateway, jobs, and scheduler disabled and maintenance enabled for the initial bring-up.
For a remote managed PostgreSQL server, remove the bundled database and its `depends_on` entry
in a separate Compose configuration, use `sslmode=verify-full`, and set the Docker TLS exception
to `false`. PostgreSQL is required; an R2 bucket or D1 database does not replace it.

## 3. Start the application

Choose one image path. Commands in this guide run from `infra/self-host`.

### Build from source

Set `HAF_IMAGE=haf-bot:self-host` in `.env`, then build the reviewed checkout:

```sh
docker compose -f compose.yaml -f compose.source.yaml config --quiet
docker compose -f compose.yaml -f compose.source.yaml build app
docker compose -f compose.yaml -f compose.source.yaml up -d --wait
```

This builds the production Dockerfile, including the dashboard, landing pages, and Node runtime.
Record the source commit and resulting image ID. Use these Compose commands for source builds.

### Use a tested registry image

The initial release supplies no public registry image. If you operate your own registry, build
the reviewed source, run its validation, push the result and set `HAF_IMAGE` to that immutable
digest. Keep registry credentials private. The hosted service's images are separately controlled.

```sh
docker compose config --quiet
docker compose pull
docker compose up -d --wait
```

Both paths initialize the current public schema on an empty PostgreSQL database. No inherited
upgrade history is applied. Inspect container
status and sanitized logs if startup fails. `docker compose config --quiet` validates configuration
without printing the resolved secrets.

```sh
curl --fail http://127.0.0.1:8080/health/live
curl --fail http://127.0.0.1:8080/health/ready
```

The app is published only on the host's loopback interface. PostgreSQL has no host port and uses
the internal `data` network. Do not run `docker compose down -v` on an installation you need to keep.

## 4. Publish through Cloudflare Tunnel

Create a remotely managed tunnel in your Cloudflare dashboard and map `bot.example.com` to the
local application. Use one connector location:

- **Host connector:** run `cloudflared` as a managed service on the Docker host and set the tunnel's
  service URL to `http://localhost:8080`.
- **Docker connector:** use the included overlay and set the service URL to `http://app:8080`.
  `localhost` inside the connector container refers to that container, not the HAF app.

For the Docker connector, select a reviewed official `cloudflare/cloudflared` image, record its
digest, and set `CLOUDFLARED_IMAGE=cloudflare/cloudflared@sha256:...` in `.env`. Obtain the tunnel
token from your Cloudflare account and write only the token to `infra/self-host/tunnel-token` using a
private editor. Do not put it in a shell command or commit it. On the Linux host, give the
connector's UID read access:

```sh
sudo chown 65532:65532 tunnel-token
sudo chmod 400 tunnel-token
docker compose -f compose.yaml -f compose.tunnel.yaml config --quiet
docker compose -f compose.yaml -f compose.tunnel.yaml up -d --wait
```

If you built from source, retain both overlays in subsequent commands:

```sh
docker compose -f compose.yaml -f compose.source.yaml -f compose.tunnel.yaml up -d --wait
```

The connector shares only the `edge` network with the app; it has no direct database network access.
The token file is mounted read-only. Rootless/user-remapped Docker may require mapping UID 65532
to the corresponding host UID. An existing host connector can instead use
`cloudflared tunnel --no-autoupdate run --token-file /path/to/private/tunnel-token` under its service
manager. See Cloudflare's [tunnel setup](https://developers.cloudflare.com/learning-paths/clientless-access/connect-private-applications/create-tunnel/)
and [token-file reference](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/configure-tunnels/run-parameters/#token-file).

Keep `/interactions`, Discord OAuth callbacks and provider webhooks reachable by their callers.
A blanket Cloudflare Access login or browser challenge prevents Discord and webhook providers from
calling them. The app still verifies signatures and dashboard authorization. Bypass caching for
dynamic API, authentication, interactions, webhooks and private media routes; never cache the
dashboard's authenticated responses or private object content.

## 5. Activate and verify

Use an empty PostgreSQL database and your own bot identity. This public release initializes the
current schema and provides no data conversion or upgrade runner. Database leases coordinate
processes using the same database.

1. Set `HAF_GATEWAY_ENABLED=true`, recreate the app using your selected Compose files, and verify
   Gateway ownership with authenticated `/internal/status`. Keep maintenance enabled.
2. Set `HAF_JOBS_ENABLED=true`, recreate and verify jobs. Then set `HAF_SCHEDULER_ENABLED=true`,
   recreate and verify the scheduler. Do not reset job or operation receipts to clear failures.
3. Set `HAF_MAINTENANCE_MODE=false` and recreate the app. Confirm HTTPS readiness through the tunnel.
4. Save the interactions endpoint in Discord and register this application's commands:

   ```sh
   docker compose exec app node dist-node/discord-command-sync.mjs
   ```

   This replaces the application's global command set with the enabled HAF commands. When both
   private operator IDs are configured, it also registers `/haf-admin` only in that Guild. Use an
   application dedicated to this installation; do not share it with another bot implementation.
   Open your own `/install` and invite the bot into your test Guild. Confirm dashboard OAuth login,
   a safe command, and one feature workflow. Check
   transcript/media upload and authorized retrieval before relying on object-dependent features.

Use `Authorization: Bearer <HAF_STATUS_TOKEN>` for `/internal/status` through a private operator
client. Do not put the token in a public URL, shared screenshot, or command history. Liveness and
readiness alone do not prove the Discord connection, provider integrations or backup recovery work.

## Features, billing and optional integrations

With `HAF_DEPLOYMENT_MODE=self-hosted`, all core feature capabilities are available without a
hosted HAF subscription. The runtime uses the existing Premium Plus per-Guild capabilities without
creating a subscription, Guild Assignment or billing record. Existing resource and abuse limits
remain, including a 1 GB per-Guild managed-object allowance, 25 Clans per Guild and five officers
per Clan. Discord limits and feature-specific validation still apply. This mode does not grant a
hosted white-label subscription or provider services. Keep all processes using the same mode;
leaving the setting absent retains the hosted Free/paid rules. Do not edit entitlement rows as an
installation step.

The core deployment does not require HAF's Stripe account. Leave Stripe settings absent and
`COMMERCE_ENABLED=false` unless you deliberately configure your own integration. Commerce remains
a restricted pilot. AI image classification and transcript summaries require a compatible provider;
Steam, Xbox, Turnstile and game-server integrations require their own credentials and configuration.
The source license does not grant access to any hosted API, provider account or subscription.

Sentry and product analytics are optional. Leave `SENTRY_DSN`, `POSTHOG_HOST`,
`POSTHOG_PROJECT_TOKEN` and `PRODUCT_ANALYTICS_PSEUDONYM_KEY` unset unless you choose to use them.
Review the built-in terms, privacy text, support links and canonical URLs before inviting users:
some still describe the official hosted service and need operator-specific treatment.

## Backups and updates

Back up PostgreSQL, private object data and metadata, the private environment file, signing keys,
the deployed image identity and source commit to encrypted storage outside the Docker host. Test
restoring to an isolated database with Gateway/jobs/scheduler disabled. A volume or an image is not
a backup. Do not reuse the production bot identity during a restore drill.

Before updating, record the previous image and take a verified backup. Pull a tested digest, or
build a new reviewed commit under a new local tag, and recreate the app with the same Compose files.
Verify readiness, Gateway ownership, jobs, scheduler, OAuth and a safe Discord workflow. The
application expects the current installation schema. This release contains no schema upgrade
mechanism; a backup restore must use the matching application release.

See `infra/self-host/README.md` for the generic Compose layout.
