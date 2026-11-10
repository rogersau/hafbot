/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import type {
  FeatureSetupDefinition,
  SetupResource,
  SetupResourceChoice,
} from "../src/feature-setup";
import { FeatureSetupRunner } from "../src/services/feature-setup-runner";
import type { FeatureSetupStore } from "../src/runtime/contracts";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

test("FeatureSetupRunner retains successful resources and resumes without duplicate creation", async () => {
  const store = createFeatureSetupStore();
  const created: string[] = [];
  const applied: string[] = [];
  let failReviewCategory = true;
  const definition = definitionFixture({
    created,
    applied,
    failCreate(key) {
      if (key === "review_category" && failReviewCategory) {
        failReviewCategory = false;
        return true;
      }
      return false;
    },
  });
  let id = 0;
  const runner = new FeatureSetupRunner(
    store,
    () => ++id,
    () => `run-${id}`,
  );
  const choices = createChoices();

  const incomplete = await runner.execute(definition, "admin-1", choices);
  assert.equal(incomplete.status, "incomplete");
  assert.equal(incomplete.failureDependencyKey, "review_category");
  assert.deepEqual(created, ["managed_category", "review_category"]);
  assert.deepEqual(applied, ["managed_category"]);

  const completed = await runner.execute(definition, "admin-1", choices);
  assert.equal(completed.id, incomplete.id);
  assert.equal(completed.status, "completed");
  assert.deepEqual(created, [
    "managed_category",
    "review_category",
    "review_category",
    "reviewer_role",
  ]);
  assert.deepEqual(applied, ["managed_category", "review_category", "reviewer_role"]);
});

test("FeatureSetupRunner supports mixed reuse and create choices", async () => {
  const store = createFeatureSetupStore();
  const created: string[] = [];
  const applied: string[] = [];
  const definition = definitionFixture({ created, applied });
  const runner = new FeatureSetupRunner(
    store,
    () => 10,
    () => "run-1",
  );
  const choices = createChoices();
  choices.managed_category = { action: "reuse", resourceId: "existing-category" };

  const preview = await runner.preview(definition, choices);
  assert.equal(preview.dependencies[0]?.relationship, "referenced");
  assert.equal(preview.dependencies[1]?.relationship, "haf_configured");

  const run = await runner.execute(definition, "admin-1", choices);
  assert.equal(run.status, "completed");
  assert.deepEqual(created, ["review_category", "reviewer_role"]);
  assert.equal(run.resolutions[0]?.resource.id, "existing-category");
});

test("FeatureSetupRunner counts Unicode code points for resource-name limits", async () => {
  const store = createFeatureSetupStore();
  const definition = definitionFixture({ created: [], applied: [] });
  const runner = new FeatureSetupRunner(store);
  const choices = createChoices();
  choices.managed_category = { action: "create", name: `${"🎮".repeat(100)} ` };

  const preview = await runner.preview(definition, choices);
  assert.equal(preview.dependencies[0]?.choice.action, "create");
  assert.equal(
    preview.dependencies[0]?.choice.action === "create"
      ? preview.dependencies[0].choice.name
      : null,
    "🎮".repeat(100),
  );

  choices.managed_category = { action: "create", name: "🎮".repeat(101) };
  await assert.rejects(() => runner.preview(definition, choices), /between 1 and 100 characters/);
});

test("FeatureSetupRunner records a resource before retrying failed configuration application", async () => {
  const store = createFeatureSetupStore();
  const created: string[] = [];
  const applied: string[] = [];
  let applyFailures = 1;
  const definition = definitionFixture({
    created,
    applied,
    failApply(key) {
      return key === "managed_category" && applyFailures-- > 0;
    },
  });
  const runner = new FeatureSetupRunner(
    store,
    () => 20,
    () => "run-1",
  );
  const choices = createChoices();

  assert.equal((await runner.execute(definition, "admin-1", choices)).status, "incomplete");
  assert.deepEqual(created, ["managed_category"]);
  assert.equal((await runner.execute(definition, "admin-1", choices)).status, "completed");
  assert.deepEqual(created, ["managed_category", "review_category", "reviewer_role"]);
});

test("FeatureSetupRunner does not duplicate an ambiguously persisted Discord creation", async () => {
  const store = createFeatureSetupStore();
  const persistResolution = store.upsertResolution.bind(store);
  let failResolutionOnce = true;
  store.upsertResolution = async (resolution) => {
    if (failResolutionOnce) {
      failResolutionOnce = false;
      throw new Error("D1 unavailable after Discord creation");
    }
    await persistResolution(resolution);
  };
  const created: string[] = [];
  const applied: string[] = [];
  const definition = definitionFixture({ created, applied });
  const runner = new FeatureSetupRunner(
    store,
    () => 30,
    () => "run-1",
  );
  const choices = createChoices();

  const interrupted = await runner.execute(definition, "admin-1", choices);
  assert.equal(interrupted.status, "incomplete");
  assert.equal(interrupted.pendingCreationDependencyKey, "managed_category");
  assert.deepEqual(created, ["managed_category"]);

  const guardedRetry = await runner.execute(definition, "admin-1", choices);
  assert.equal(guardedRetry.status, "incomplete");
  assert.match(guardedRetry.failureMessage ?? "", /Select the created resource with Reuse/);
  assert.deepEqual(created, ["managed_category"]);

  choices.managed_category = { action: "reuse", resourceId: "managed_category-id" };
  const repaired = await runner.execute(definition, "admin-1", choices);
  assert.equal(repaired.status, "completed");
  assert.deepEqual(created, ["managed_category", "review_category", "reviewer_role"]);
});

test("FeatureSetupRunner makes repeated confirmation idempotent", async () => {
  const store = createFeatureSetupStore();
  const created: string[] = [];
  const applied: string[] = [];
  const definition = definitionFixture({ created, applied });
  const runner = new FeatureSetupRunner(
    store,
    () => 40,
    () => "unused-run-id",
  );
  const choices = createChoices();

  const first = await runner.execute(definition, "admin-1", choices, "confirmation-1");
  const repeated = await runner.execute(definition, "admin-1", choices, "confirmation-1");

  assert.equal(first.id, "confirmation-1");
  assert.equal(repeated.id, first.id);
  assert.deepEqual(created, ["managed_category", "review_category", "reviewer_role"]);
});

test("FeatureSetupRunner preserves prior relationship when repairing the same resource", async () => {
  const store = createFeatureSetupStore();
  const definition = definitionFixture({ created: [], applied: [] });
  const runner = new FeatureSetupRunner(
    store,
    () => 50,
    () => "run-1",
  );
  await runner.execute(definition, "admin-1", createChoices());

  const repairChoices = createChoices();
  repairChoices.managed_category = {
    action: "reuse",
    resourceId: "managed_category-id",
  };
  const preview = await runner.preview(definition, repairChoices);

  assert.equal(preview.dependencies[0]?.relationship, "haf_managed");
});

test("FeatureSetupRunner reports configured Discord resource drift and recovers", async () => {
  const store = createFeatureSetupStore();
  let missingResourceId: string | null = null;
  const definition = definitionFixture({
    created: [],
    applied: [],
    invalidReuse(resourceId) {
      return resourceId === missingResourceId;
    },
  });
  const runner = new FeatureSetupRunner(
    store,
    () => 60,
    () => "run-1",
  );
  await runner.execute(definition, "admin-1", createChoices());

  missingResourceId = "managed_category-id";
  const needsAttention = await runner.readState(definition);
  assert.equal(needsAttention.readiness, "needs_attention");
  assert.equal(
    needsAttention.run?.resolutions.find(
      (resolution) => resolution.dependencyKey === "managed_category",
    )?.validationStatus,
    "needs_attention",
  );

  missingResourceId = null;
  const recovered = await runner.readState(definition);
  assert.equal(recovered.readiness, "ready_disabled");
  assert.equal(
    recovered.run?.resolutions.find((resolution) => resolution.dependencyKey === "managed_category")
      ?.validationStatus,
    "valid",
  );
});

function createChoices(): Record<string, SetupResourceChoice> {
  return {
    managed_category: { action: "create", name: "HAF Clans" },
    review_category: { action: "create", name: "Clan Reviews" },
    reviewer_role: { action: "create", name: "Clan Reviewer" },
  };
}

function definitionFixture(options: {
  created: string[];
  applied: string[];
  failCreate?: (key: string) => boolean;
  failApply?: (key: string) => boolean;
  invalidReuse?: (resourceId: string) => boolean;
}): FeatureSetupDefinition {
  const configured: Record<string, string | null> = {
    managed_category: null,
    review_category: null,
    reviewer_role: null,
  };
  return {
    guildId: "guild-1",
    featureKey: "clan_management",
    version: 1,
    preflight: async () => {},
    dependencies: Object.keys(configured).map((key) => ({
      key,
      label: key,
      kind: key === "reviewer_role" ? ("role" as const) : ("category" as const),
      recommendedName: key,
      createdRelationship: key === "managed_category" ? "haf_managed" : "haf_configured",
      templateVersion: 1,
      permissionSummary: "Minimum permissions",
      async validateReuse(resourceId): Promise<SetupResource> {
        if (options.invalidReuse?.(resourceId)) throw new Error(`Missing ${resourceId}`);
        return {
          id: resourceId,
          name: `existing-${key}`,
          kind: key === "reviewer_role" ? "role" : "category",
        };
      },
      async create(name): Promise<SetupResource> {
        options.created.push(key);
        if (options.failCreate?.(key)) throw new Error(`Failed ${key}`);
        return {
          id: `${key}-id`,
          name,
          kind: key === "reviewer_role" ? "role" : "category",
        };
      },
      async apply(resource) {
        if (options.failApply?.(key)) throw new Error(`Could not apply ${key}`);
        options.applied.push(key);
        configured[key] = resource.id;
      },
    })),
    async readConfiguration() {
      return { enabled: false, dormant: false, resourceIds: configured };
    },
  };
}

function createFeatureSetupStore(): FeatureSetupStore {
  const fixture = createProductionRuntimeStores();
  if (!fixture.stores.featureSetup) throw new Error("Feature Setup store is unavailable.");
  return fixture.stores.featureSetup;
}
