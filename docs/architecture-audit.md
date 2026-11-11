# Public architecture audit

The public baseline assumes no active deployments, installed data, historical customers or posted
Discord controls to preserve. Its source and installation schema describe the current product.

## Runtime and persistence

Node.js with PostgreSQL is the application runtime. The Node composition root selects native
PostgreSQL stores before constructing services, authentication, queue consumers and Gateway
capabilities. Feature services receive persistence through contracts. They do not construct stores
or choose a database based on an absent binding.

Production contains no Worker entrypoint, Durable Objects, D1 facade or SQL dialect translator.
Process caches use a small cache contract. S3 and Azure object stores are current provider adapters.

Services are composed after native stores, object capabilities and credentials are selected.
HTTP, native job delivery and scheduled work consume the same instances; maintenance HTTP
has a separate read-only composition. Handlers and Admin routes require selected services.
Native jobs use payload/metadata inputs and explicit outcomes, retaining retry/terminal reasons
and delay without former batch callbacks. Missing outcomes are terminal.

SQLite implementations and their current schema fixture live under `test/support` for isolated
service tests. Production cannot import those fixtures. Architecture tests enforce that boundary,
service persistence injection and the absence of request-time schema changes.

## Fresh installation

[`schema/postgres.sql`](../schema/postgres.sql) is the installation schema, including current
built-in identity recognizers. Startup initializes an empty database in one transaction under an
initialization lock. Concurrent initialization and reopening the current schema are supported.
The initializer checks the application table set; operators must use the matching current schema.

The repository has no migration directory, migration ledger, upgrade runner, migration flags or
historical upgrade tests. `pnpm postgres:init` initializes the current schema. Object conversion
CLIs and stale source-assembly manifests were also removed.

## Canonical contracts

- Commerce Offerings use one lifecycle row with explicit pre-repair state, without a side-table
  projection. Platform Link config and enabled state save atomically.
- Billing recognizes the four configured plan/interval prices. Historical cohorts, Founder fields,
  the private paid-role archive and duplicate stored plan fields are removed.
- Player Links use one platform-wide representation, with no Steam-specific persistence, fallback
  reads or duplicate Admin API routes.
- Reaction Role panels use one ordered table. Evidence Vault access uses a role list and private
  object metadata. Tickets use response rules and the current panel document shape.
- Managed Media requires explicit visibility and content classification.
- Webhook Proxy configuration stores encrypted credential references. Plaintext destination
  columns, duplicate destination documents and credential-conversion timestamps are removed.
  Queue consumers reject plaintext webhook and notification payloads.
- Gateway queues require the current version and a matching event key. Sensitive Discord controls
  require current signatures and actor/generation fields. Signing-key rotation remains supported.
- Dashboard errors have one public envelope. The client uses a safe message when an intermediary
  returns an invalid response; it does not interpret retired error formats.

Native transactions retain idempotency, lease ownership, Guild isolation and concurrency controls.
Award deductions serialize per member so concurrent adjustments cannot exceed the available
balance. Billing assignment capacity, Commerce reconciliation and provider-action recovery use
native PostgreSQL transactions and fencing.

## Validation

Validation covers the current application build, Node/browser type boundaries, public behavior,
architecture rules, native PostgreSQL contracts and fresh container initialization. The PostgreSQL
checks use an isolated local PostgreSQL 16 database. Public tests use fictional credentials and
local service boundaries.

The current combined source includes the preserved PostgreSQL concurrency regressions and
fresh-install fixes. Final broad builds, types, public/native tests, documentation and container
readiness are being rerun together. Exact results and accepted source SHAs are recorded in
[`clean-slate-progress.md`](clean-slate-progress.md).

Live Discord, OAuth, provider operations and an independently operated deployment/restore
rehearsal are outside this source audit.
