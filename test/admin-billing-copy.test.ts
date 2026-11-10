/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { presentBillingHistory } from "../src/admin/components/admin-billing-page";

test("Billing history translates internal lifecycle and plan names for customers", () => {
  const presentation = presentBillingHistory({
    id: "event-1",
    createdAtMs: Date.UTC(2026, 6, 15),
    summaryJson: JSON.stringify({
      summary: "subscription plan changed",
      resultingAccess: "premium_plus",
    }),
  });

  assert.equal(presentation.title, "Plan changed to Premium Plus");
  assert.match(presentation.detail, /^Premium Plus access became active on 15 July 2026\.$/);
  assert.doesNotMatch(
    `${presentation.title} ${presentation.detail}`,
    /premium_plus|Effective|Access:/,
  );
});

test("Billing history remains readable when an old summary is malformed", () => {
  const presentation = presentBillingHistory({
    id: "event-2",
    createdAtMs: Date.UTC(2026, 6, 15),
    summaryJson: "not-json",
  });

  assert.equal(presentation.title, "Subscription updated");
  assert.match(presentation.detail, /15 July 2026/);
});
