# Security policy

Security fixes target the current default branch. No older-version maintenance or response-time
commitment is implied. Self-hosting operators own their updates, backups, provider credentials,
Discord permissions and incident response.

Use [GitHub private vulnerability reporting](https://github.com/rogersau/hafbot/security/advisories/new).
Do not post vulnerability details or credentials in a public issue.

Provide the affected source version, prerequisites, impact and a minimal reproduction with your
own test application/Guild. Redact tokens, webhook URLs, member/payment details and private evidence.
Revoke exposed credentials at their issuer. Deleting a file does not revoke its credentials.

Follow [the self-hosting guide](docs-site/self-hosting.md). Keep PostgreSQL and private objects
inaccessible directly from the Internet, protect signing/encryption keys, and leave optional
telemetry credentials unset unless you deliberately operate and disclose that integration.
