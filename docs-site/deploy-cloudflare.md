---
title: Deploy with Cloudflare
description: Use Cloudflare Tunnel, private R2 storage and Pages with HAF Bot, and understand the work required for a fully Cloudflare-hosted runtime.
---

# Deploy with Cloudflare

The current supported app is Node.js plus PostgreSQL. You can use Cloudflare for Tunnel ingress,
DNS, security controls, private R2 object storage, and Pages documentation while running the
application on your Docker host. Follow [the Docker guide](/self-hosting) for executable setup.

## Can everything run on Cloudflare?

There is currently no maintained, tested deployment of this release entirely on Cloudflare.
The repo retains Workers/D1/Durable Objects/Queues/KV/R2 code, and the Node runtime still uses
several of those stores through a PostgreSQL compatibility adapter. This release supplies no
Worker deployment configuration or Cloudflare-only installer. The current PostgreSQL schema is `schema/postgres.sql`. Startup initializes an empty database
without replaying private deployment history. The SQLite schema under `test/support/fixtures`
is only an adapter test fixture.

Restoring a Cloudflare-only release is a separate project. The
[architecture audit](https://github.com/rogersau/hafbot/blob/main/docs/architecture-audit.md)
records the remaining runtime coupling and cleanup work.

## Use private R2 object storage

Create a private R2 bucket in your own account. Create S3 API credentials with Object Read & Write
permissions scoped to that bucket. Keep public bucket access disabled: transcripts and evidence
are served through the application's authorization and signed-link paths.

Set these in the app's private environment:

```dotenv
S3_BUCKET_NAME=your-private-haf-bucket
S3_REGION=auto
S3_ENDPOINT=https://YOUR_ACCOUNT_ID.r2.cloudflarestorage.com
S3_FORCE_PATH_STYLE=true
AWS_ACCESS_KEY_ID=replace-with-your-r2-access-key-id
AWS_SECRET_ACCESS_KEY=replace-with-your-r2-secret-access-key
```

Use R2's S3 access key pair, not a general Cloudflare API bearer token. Configure only one object
provider; remove Azure Blob settings when using S3/R2. `TICKET_TRANSCRIPTS_BUCKET` is a legacy
Worker binding and is not how the Docker app selects a bucket. Test uploading, reading and deleting
an authorized test object, and back up the object data as well as PostgreSQL.

These settings use Cloudflare's documented [S3 interface](https://developers.cloudflare.com/r2/get-started/s3/)
and [R2 region/endpoint convention](https://developers.cloudflare.com/r2/api/s3/api/).

## Publish documentation on Pages

The documentation is a static VitePress site. From a source checkout, run
`pnpm install --frozen-lockfile`, then `pnpm docs:build`. The output is
`docs-site/.vitepress/dist`. Publish that directory to your own Pages project with the
[Pages direct-upload flow](https://developers.cloudflare.com/pages/get-started/direct-upload/).

Update the hostname, canonical metadata, navigation and hosted-service links in
`docs-site/.vitepress/config.mts` and relevant pages for your fork. The repository's `docs:deploy`
script names the maintainer's Pages project; use your own project instead. Pages hosts the
documentation, not the Node application or Discord Gateway.

## What a Cloudflare Containers deployment would need

Cloudflare Containers can run an OCI image, but this repository does not supply the Worker/Durable
Object controller and routing configuration required to operate it there. Cloudflare documents
[the container lifecycle](https://developers.cloudflare.com/containers/concepts/architecture/)
and [the Durable Object Container API](https://developers.cloudflare.com/containers/api/durable-object-container/).

A future adapter must be implemented and tested for:

- Worker-to-container routing, public origin handling, required secrets and port readiness;
- continuous Gateway, jobs and scheduler operation even when no public HTTP requests arrive,
  including restart, inactivity, rollout, reconnect and lease-renewal behavior;
- durable PostgreSQL outside the container's ephemeral filesystem, with verified TLS, migrations,
  database backups and recovery; Durable Object SQLite and D1 do not satisfy the current PostgreSQL
  store contracts;
- private R2 through the existing S3 interface, with credentials and object recovery;
- singleton Gateway ownership and scheduler fencing across restarts and deployments;
- bounded resource use, current platform pricing, monitoring and an independently tested rollback.

Cloudflare documents that container disks are ephemeral by default. Do not treat a PostgreSQL
container filesystem or an R2 FUSE mount as a substitute for the production database's durability
and recovery requirements. A Containers adapter would still require a PostgreSQL service, so it
would not by itself provide a deployment using only Cloudflare products.

## What reviving Workers/D1 would need

A separate supported release would need fresh-account resource provisioning, sanitized example
Wrangler configuration, explicit secret setup, current D1 migration checks, Gateway/queue/retry
tests, scoped deployment credentials, budget controls and recovery evidence. PostgreSQL state and
SQL are not interchangeable with D1; Cloudflare explicitly documents the
[PostgreSQL import limitation](https://developers.cloudflare.com/d1/best-practices/import-export-data/).

Until that work is complete, use Docker with Tunnel and optional R2. This gives you Cloudflare
ingress and storage while retaining the verified Node/PostgreSQL deployment shape.
