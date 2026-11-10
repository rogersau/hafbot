/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { createEmptyTicketType } from "../src/admin/components/ticket-panel-form-state";

test("new Ticket types disable participant management", () => {
  assert.equal(createEmptyTicketType(0).participantManagementEnabled, false);
});
