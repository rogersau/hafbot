# Independent Docker installation

Follow [the self-hosting guide](../../docs-site/self-hosting.md). Run Compose with
`compose.yaml` and `compose.source.yaml`; add `compose.tunnel.yaml` only if using a
containerized Tunnel connector. Private credentials stay in ignored `.env` and `tunnel-token`.

Managed PostgreSQL must use `sslmode=verify-full`; disable the Docker-only TLS exception.
