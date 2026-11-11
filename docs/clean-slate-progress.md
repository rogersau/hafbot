# Public clean-slate integration

This is the authoritative combined inventory for the architecture audit and task audit.
The integration base is `t3/architectural-clean-slate-audit`. Public installations start empty;
there are no active deployments, inherited compatibility requirements or upgrade migrations.

## Ownership

| Area                                                     | Owner                              | State and evidence                                                                  |
| -------------------------------------------------------- | ---------------------------------- | ----------------------------------------------------------------------------------- |
| Native PostgreSQL stores and runtime composition         | Architecture thread                | Implemented; 111 PostgreSQL contracts pass                                          |
| Worker/D1 production removal and injected handlers       | Architecture thread                | Implemented; 7 architecture checks pass; SQLite is test-only                        |
| Canonical installation schema and startup                | Architecture thread                | Implemented; fresh-schema container readiness passes                                |
| Canonical persisted and queue documents                  | Architecture thread                | Implemented; current signatures, Gateway envelopes and encrypted webhook references |
| Server error contract                                    | Architecture thread                | Current fields only; latest cleanup needs rerun                                     |
| Admin loading/error UI, prototypes and shared validation | Task thread                        | Distinct-fix manifest and remaining adapted work requested                          |
| Service atomicity and regressions                        | Integration by architecture thread | Preserve and reconcile distinct task fixes individually                             |
| Final combined validation                                | Architecture thread                | Pending combined integration                                                        |

## Reconciliation queue

- Read the task thread's distinct-fix manifest and map its task IDs to this inventory.
- Port the configuration/clear versus burst-recording serialization invariant from `94baa1a`,
  preserving its PostgreSQL concurrency regression. Do not overwrite native adapters with the
  overlapping `fb3065a` ports.
- Inspect and remove the unused R2 Workers metadata conversion mode. The conversion CLI is
  already removed; the current S3 adapter still exposes that mode.
- Make current game-access transmission markers require their operation identity.
- Accept only distinct remaining task work adapted onto the architecture checkpoint. Verify
  equivalent behavior before marking an overlapping task covered.

## Checkpoint validation

| Check                                      | Latest result                                                                     |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| Native PostgreSQL suite                    | 111 passed, 0 failed                                                              |
| Build behavior                             | 19 passed, 0 failed                                                               |
| Architecture                               | 7 passed, 0 failed                                                                |
| Public suite                               | 3,513 passed, 2 failed, 59 skipped; the two error-fixture corrections await rerun |
| Application and test builds                | Passed before the final error-contract edit                                       |
| Node, Admin and shared type checks         | Passed before the final error-contract edit                                       |
| Lint                                       | No errors; 13 existing React Effect warnings                                      |
| Formatting and diff whitespace             | Passed before the final error-contract edit                                       |
| Documentation build                        | Passed                                                                            |
| Production container with fresh PostgreSQL | Passed                                                                            |

The two failing public assertions expected an invalid error envelope to be accepted as a malformed
fixture and a retired stale-preview conversion. Their fixtures now exercise the current contract.
Ticket response validation also now enforces the same Discord modal limits as writes. These changes
must be validated together before the integration is considered complete.
