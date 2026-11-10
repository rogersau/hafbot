/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { reportDashboardMilestone } from "../src/admin/lib/product-analytics";

test("Dashboard milestone client sends only the explicit Guild-scoped catalog event", async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    requests.push({ input, init });
    return Response.json({ accepted: true }, { status: 202 });
  };

  try {
    await reportDashboardMilestone({
      guildId: "guild-1",
      workspaceId: "workspace-1",
      action: "onboarding_goal_selected",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.input, "/admin/api/product-analytics/events");
  assert.deepEqual(JSON.parse(requests[0]!.init?.body as string), {
    event: "milestone",
    guildId: "guild-1",
    workspaceId: "workspace-1",
    action: "onboarding_goal_selected",
  });
});
