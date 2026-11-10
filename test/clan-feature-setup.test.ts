/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import type { SetupResource } from "../src/feature-setup";
import { ClanFeatureSetupService } from "../src/services/clan-feature-setup";
import { FeatureSetupRunner } from "../src/services/feature-setup-runner";
import { createCloudflareClanStore } from "../src/runtime/cloudflare-clan-store";
import { createCloudflareFeatureSetupStore } from "../src/runtime/cloudflare-feature-setup-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("Clan Feature Resource Setup mixes Create and Reuse and keeps the feature disabled", async () => {
  const database = new SqliteD1Database() as unknown as D1Database;
  const clans = createCloudflareClanStore(database);
  const setupStore = createCloudflareFeatureSetupStore(database);
  const resources = new Map<string, SetupResource>([
    ["existing-panel", { id: "existing-panel", name: "clans", kind: "text_channel" }],
    ["existing-reviewer", { id: "existing-reviewer", name: "Staff", kind: "role" }],
  ]);
  const created: string[] = [];
  let historyId = 0;
  const service = new ClanFeatureSetupService(
    clans,
    new FeatureSetupRunner(
      setupStore,
      () => 100,
      () => "run-1",
    ),
    {
      async preflight() {},
      async readResource(_guildId, resourceId, kind) {
        const resource = resources.get(resourceId);
        if (!resource || resource.kind !== kind) throw new Error("Wrong resource type");
        return resource;
      },
      async createCategory(input) {
        created.push(input.name);
        const resource = {
          id: `category-${created.length}`,
          name: input.name,
          kind: "category" as const,
        };
        resources.set(resource.id, resource);
        return resource;
      },
      async createTextChannel(input) {
        created.push(input.name);
        return { id: `channel-${created.length}`, name: input.name, kind: "text_channel" };
      },
      async createRole(input) {
        created.push(input.name);
        return { id: `role-${created.length}`, name: input.name, kind: "role" };
      },
    },
    () => 100,
    () => `history-${++historyId}`,
  );

  const run = await service.execute("guild-1", "admin-1", {
    managed_category: { action: "create", name: "HAF Clans" },
    panel_channel: { action: "reuse", resourceId: "existing-panel" },
    review_category: { action: "create", name: "Clan Reviews" },
    reviewer_role: { action: "reuse", resourceId: "existing-reviewer" },
  });

  assert.equal(run.status, "completed");
  assert.deepEqual(created, ["HAF Clans", "Clan Reviews"]);
  const config = await clans.readConfig("guild-1");
  assert.equal(config?.enabled, false);
  assert.equal(config?.categoryId, "category-1");
  assert.equal(config?.requestPanelChannelId, "existing-panel");
  assert.equal(config?.requestReviewCategoryId, "category-2");
  assert.deepEqual(config?.reviewerRoleIds, ["existing-reviewer"]);
  assert.equal((await service.readState("guild-1")).readiness, "ready_disabled");
});
