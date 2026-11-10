/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import { formatTimedRoleExpiry, parseTimedRoleDuration } from "../src/timed-roles";

test("parseTimedRoleDuration accepts hour, week, and month units", () => {
  assert.deepEqual(parseTimedRoleDuration("1h", 1_700_000_000_000), {
    durationInput: "1h",
    expiresAtMs: 1_700_003_600_000,
  });
  assert.deepEqual(parseTimedRoleDuration("1w", 1_700_000_000_000), {
    durationInput: "1w",
    expiresAtMs: 1_700_604_800_000,
  });
  assert.equal(
    parseTimedRoleDuration("1m", Date.UTC(2026, 0, 15, 0, 0, 0))?.expiresAtMs,
    Date.UTC(2026, 1, 15, 0, 0, 0),
  );
});

test("parseTimedRoleDuration clamps month durations to the last day of the target month", () => {
  assert.equal(
    parseTimedRoleDuration("1m", Date.UTC(2026, 0, 31, 0, 0, 0))?.expiresAtMs,
    Date.UTC(2026, 1, 28, 0, 0, 0),
  );
});

test("parseTimedRoleDuration rejects malformed input", () => {
  assert.equal(parseTimedRoleDuration("15", 1_700_000_000_000), null);
  assert.equal(parseTimedRoleDuration("1d", 1_700_000_000_000), null);
  assert.equal(parseTimedRoleDuration("", 1_700_000_000_000), null);
});

test("formatTimedRoleExpiry renders a Discord relative timestamp", () => {
  assert.equal(formatTimedRoleExpiry(1_700_000_000_000), "<t:1700000000:R>");
});
