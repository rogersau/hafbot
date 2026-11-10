# Test seams

HAF Bot tests exercise the highest practical public seam and assert caller-visible outcomes.

| Area                  | Preferred seam                                                                       |
| --------------------- | ------------------------------------------------------------------------------------ |
| Worker/runtime        | `SELF.fetch`, queue or Durable Object public methods with production-shaped bindings |
| Admin API             | `Request -> Response` through production route, service and store composition        |
| Domain services       | Public service method with production Cloudflare stores over SQLite                  |
| Persistence           | Production store public methods over SQLite/D1                                       |
| Admin UI              | Rendered DOM and user interactions                                                   |
| Scripts/build/release | Executed CLI/process and emitted files or evidence                                   |
| External providers    | Controlled HTTP/resource boundary fake                                               |

## Rules

- Seed and inspect HAF state through production store APIs. Use `createTestDatabase` or `createProductionRuntimeStores` from `test/support` rather than recreating a store with arrays or Maps.
- Keep fakes at true system boundaries: Discord and third-party HTTP APIs, Stripe, R2/KV/Queues when that resource is the subject, time, randomness, generated IDs, filesystem and child processes.
- To prove recovery, wrap only the production method or database operation that must fail. Do not implement the rest of the store contract again.
- Assert persisted state, HTTP responses, rendered DOM, emitted provider requests, queue acknowledgement/retry, or recovery evidence. Do not assert private helper names or internal call order unless the order itself is the published safety contract.
- Architecture policies belong in the architecture tier and should parse structured data or enforce import/API boundaries. Behaviour tests must not inspect source spelling.
- A test should cover one coherent caller-visible behaviour. New seams need a short justification in the pull request.
