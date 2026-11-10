# Initial public source release

HAF Bot is available under the MIT license from this fresh source repository. Build the reviewed
checkout with the included Dockerfile and generic self-hosting Compose files. This release does
not publish a registry image or provide access to the official hosted service's private images,
credentials, data or infrastructure.

Automated validation covers dependency installation, application and documentation builds,
typechecks, unit/integration and PostgreSQL contracts, local container migrations/readiness,
dependency vulnerability checks and source secret scanning. These checks do not establish that
every external integration works with a newly configured operator account.

A fresh independent live Discord/OAuth installation rehearsal has not been completed. Live OAuth
completion, signed Discord ingress, Gateway/jobs/scheduler and feature command effects, Tunnel and
private-object integration, and encrypted backup followed by an isolated restore remain unverified
as an end-to-end independent installation. The repository owner chose to publish the tested source
with these limits documented. Follow [the installation guide](docs-site/self-hosting.md), use your
own test Discord application/Guild and verify those paths before inviting users.

Self-hosted mode enables core capabilities using your own provider accounts. Configure your own
operator identity, support and policy links. The official hosted service remains separately
operated. Review [security guidance](SECURITY.md) and [third-party notices](THIRD_PARTY_NOTICES.md).
