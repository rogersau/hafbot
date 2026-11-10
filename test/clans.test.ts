/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  buildClanRequestModalId,
  buildClanReviewButtonId,
  parseClanInteractionId,
} from "../src/clans";

test("Clan interaction IDs preserve request revision and trusted review decision", () => {
  const request = { id: "request-1", revision: 3 };
  assert.deepEqual(parseClanInteractionId(buildClanRequestModalId(request)), {
    action: "request-modal",
    requestId: "request-1",
    revision: 3,
  });
  assert.deepEqual(parseClanInteractionId(buildClanReviewButtonId(request, "approve")), {
    action: "review",
    requestId: "request-1",
    revision: 3,
    decision: "approve",
  });
  assert.equal(parseClanInteractionId("clan:review:request-1:3:forged"), null);
});
