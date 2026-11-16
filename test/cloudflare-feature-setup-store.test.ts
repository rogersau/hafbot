/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createSqliteFeatureSetupStore } from "./support/sqlite/runtime/sqlite-feature-setup-store";
import type { SetupRun } from "../src/feature-setup";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("Cloudflare FeatureSetupStore persists runs and applied resolutions", async () => {
  const store = createSqliteFeatureSetupStore(new SqliteD1Database() as unknown as D1Database);
  const run: SetupRun = {
    id: "run-1",
    guildId: "guild-1",
    featureKey: "clan_management",
    definitionVersion: 1,
    status: "running",
    actorUserId: "admin-1",
    choices: { category: { action: "create", name: "HAF Clans" } },
    failureDependencyKey: null,
    failureMessage: null,
    pendingCreationDependencyKey: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    completedAtMs: null,
    resolutions: [],
  };
  await store.createRun(run);
  await store.upsertResolution({
    runId: run.id,
    dependencyKey: "category",
    resource: { id: "category-1", name: "HAF Clans", kind: "category" },
    relationship: "haf_managed",
    templateVersion: 1,
    validationStatus: "valid",
    validationDetail: null,
    appliedAtMs: 2,
    createdAtMs: 1,
    updatedAtMs: 2,
  });
  await store.updateRun({ ...run, status: "completed", completedAtMs: 3, updatedAtMs: 3 });

  const saved = await store.readRun(run.id);
  assert.equal(saved?.status, "completed");
  assert.equal(saved?.resolutions[0]?.resource.id, "category-1");
  assert.equal(
    (await store.readLatestResolution("guild-1", "clan_management", "category", "category-1"))
      ?.relationship,
    "haf_managed",
  );
  assert.equal(await store.readActiveRun("guild-1", "clan_management"), null);
  assert.equal((await store.readLatestRun("guild-1", "clan_management"))?.id, run.id);
});
