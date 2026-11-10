# Public CI and source ownership

The public upstream is `rogersau/hafbot`. The hosted operator consumes reviewed public source
versions and immutable artifacts through a separate private hosting/configuration overlay.
Application changes belong upstream. Private credentials, deployment topology, customer queues,
incidents, automation authority and existing repository history do not belong in this source tree.

The proposed validation workflow uses fresh GitHub-hosted Ubuntu runners for each job, handles
`pull_request` with normal fork restrictions, declares only `contents: read`, disables persisted
checkout credentials, and pins actions to immutable commits. It reads no repository/environment
secrets, grants no OIDC or publishing permissions, and contains no deployment or privileged follow-on
workflow. PostgreSQL credentials are public, disposable test fixtures. Container builds use only
that job's temporary Docker daemon. No persistent runner, private network or shared Docker socket
is attached. Cross-run dependency/build caches are deliberately not enabled in this initial design.

The validation jobs cover build/format/lint/types, the portable unit/integration and build tests,
public docs, PostgreSQL contracts and a production Docker image smoke test. Browser test dependencies
are installed from their public distribution. Tests for excluded private operations are recorded in
the preparation's external assembly report; portable authorization/recovery tests remain included.

References: [GitHub's secure use reference](https://docs.github.com/en/actions/reference/security/secure-use)
and [fork workflow/token rules](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).
Repository settings must retain fork workflow approval controls, read-only default tokens, protected
branches and reviewed releases. Private vulnerability reporting must be enabled before launch.

This workflow is validation-only. Publishing source/images, signing/provenance, protected release
approval and the private overlay's admission of pinned upstream versions remain separately reviewed
release work. CI success does not clear artwork/notice rights, operator-specific terms/privacy or
live Discord/Tunnel/storage/backup-restore gates.
