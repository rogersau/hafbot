# Reusable Admin QA

`pnpm qa:admin` builds the real Admin SPA and drives it with the existing Playwright dependency.
Every scenario gets a new browser context and a new, method-aware fictional API. It never logs in,
contacts Discord, or calls a payment provider. Unexpected API methods/routes, external requests,
WebSockets, and uncaught page errors fail the scenario.

## Run

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm qa:admin:unit
pnpm qa:admin
```

The normal browser is the Chromium version installed by the locked Playwright package. Use the same
OS and browser version for reproducible results. A diagnostic run may explicitly opt into an existing
browser with `--browser-executable=/absolute/path/to/chromium`; the report labels this as non-pinned
and records its actual version. There is no automatic browser fallback.

```sh
pnpm qa:admin --list
pnpm qa:admin --scenario=SCENARIO_ID
pnpm qa:admin --prebuilt --output=.artifacts/admin-qa-rerun
```

`--prebuilt` skips the build only when explicitly requested. The caller is responsible for making
sure `dist-admin` matches the source under test. Unknown scenario IDs and arguments fail rather than
silently running no tests. The default run builds first; a missing build, dependency, or browser
produces `blocked` scenario results rather than a pass.

CI selects the scenarios for UI, fixture, harness, and related dependency/configuration changes,
and for manual CI dispatch. They run inside `CI / Validate` using its existing Admin build with
`--prebuilt`, after architecture checks in the second test lane while Node tests run alongside.
The harness unit tests remain in the Node suite. Run the same combined pipeline locally with
`TEST_RUN_ADMIN_QA=true pnpm test:timings`. Standalone `pnpm qa:admin` remains available.

## Evidence

`.artifacts/admin-qa/report.json` contains the source commit when available, declared source revision
when `HAF_QA_SOURCE_REVISION` is supplied, runtime versions, build result, and every scenario's status:

- `pass`: the selected scenario reached all its assertions
- `fail`: a selected scenario or invalid selection failed
- `blocked`: setup prevented a selected scenario from running
- `not-run`: the scenario was not selected

The summary counts each status separately. Exit code 0 means all selected scenarios passed; 1 means
a failure; 2 means setup was blocked or no scenario passed. Reports include fictional API requests
and unhandled calls. Failed scenarios also write a screenshot and Playwright trace when possible.
Open a trace with `pnpm exec playwright show-trace .artifacts/admin-qa/SCENARIO_ID.trace.zip`.
CI uploads the evidence even when a scenario fails. Never point this runner at a live Admin instance
or insert real customer data, tokens, or provider credentials into fixtures.

## What it proves

The scenarios cover Free/Premium and workspace owner/member render contexts, pristine and dirty
Reaction Rules, Save/Discard/Leave, browser Back/Forward with Stay, repeated saves and reload
readback, and optional LFG destinations. A lost-write negative control proves that a successful
mutation response is insufficient evidence of persistence. Unit controls verify API method handling,
reset isolation, explicit failures, and report status behavior.

The `reaction-roles-publish` scenario creates a game-role panel on Free, publishes it, verifies saved settings after a reload, and pauses it.

Workspace membership, Guild Admin access, and plan ownership are different concepts. Fixture roles
exercise frontend contexts only. The non-owner `member` persona uses the API's actual `viewer`
workspace role; `member` is not a valid workspace API role. These tests do **not** verify backend authorization, Discord
permissions or delivery, live billing, OAuth, real storage, or concurrency across backend requests.
Those need the repository's backend/integration tests and separately authorized live checks.

Known product regressions must remain failures until fixed. Do not turn a failing assertion into a
fixture success or suppress it because a related fix is in another PR. The harness adds no product
fixes and does not supersede existing focused regression tests.

## Extend

Add a scenario to `scenarios.mjs` with an ID, route, tier, workspace role, and `run` function. Prefer
visible labels or existing stable element IDs, assert the persisted state after mutations, and reload
to distinguish optimistic UI from readback. Test interrupted and repeated actions where relevant.

The API model in `api.mjs` reuses the documentation fixtures for reads. Mutations must be explicitly
implemented with their actual method, payload, response envelope, and state update. A pathname-only
catch-all that returns 200 for unknown writes is not acceptable. Keep fixture outcomes fictional and
bounded; a mock permission failure is a UI error-handling check, not an authorization test.
