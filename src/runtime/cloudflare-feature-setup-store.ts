import { and, desc, eq, inArray } from "drizzle-orm";
import { featureSetupResolutions, featureSetupRuns } from "../db/app-schema";
import type {
  ResourceRelationship,
  SetupResolution,
  SetupResourceChoice,
  SetupResourceKind,
  SetupRun,
  SetupRunStatus,
} from "../feature-setup";
import { isRecord } from "../unknown-parse";
import type { FeatureSetupStore } from "./contracts/feature-setup-store";
import { createD1DrizzleDatabase } from "./drizzle-db";

const ACTIVE_STATUSES: SetupRunStatus[] = ["planned", "running", "incomplete"];
const storeCache = new WeakMap<D1Database, FeatureSetupStore>();

export function createCloudflareFeatureSetupStore(database: D1Database): FeatureSetupStore {
  const cached = storeCache.get(database);
  if (cached) return cached;
  const db = createD1DrizzleDatabase(database);

  async function hydrate(row: typeof featureSetupRuns.$inferSelect): Promise<SetupRun> {
    const resolutions = await db
      .select()
      .from(featureSetupResolutions)
      .where(eq(featureSetupResolutions.runId, row.id))
      .all();
    return {
      id: row.id,
      guildId: row.guildId,
      featureKey: row.featureKey,
      definitionVersion: row.definitionVersion,
      status: row.status as SetupRunStatus,
      actorUserId: row.actorUserId,
      choices: parseChoices(row.choicesJson),
      failureDependencyKey: row.failureDependencyKey,
      failureMessage: row.failureMessage,
      pendingCreationDependencyKey: row.pendingCreationDependencyKey,
      createdAtMs: row.createdAtMs,
      updatedAtMs: row.updatedAtMs,
      completedAtMs: row.completedAtMs,
      resolutions: resolutions.map(mapResolution),
    };
  }

  const store: FeatureSetupStore = {
    async readRun(runId) {
      const row = await db
        .select()
        .from(featureSetupRuns)
        .where(eq(featureSetupRuns.id, runId))
        .limit(1)
        .get();
      return row ? hydrate(row) : null;
    },
    async readActiveRun(guildId, featureKey) {
      const row = await db
        .select()
        .from(featureSetupRuns)
        .where(
          and(
            eq(featureSetupRuns.guildId, guildId),
            eq(featureSetupRuns.featureKey, featureKey),
            inArray(featureSetupRuns.status, ACTIVE_STATUSES),
          ),
        )
        .orderBy(desc(featureSetupRuns.createdAtMs))
        .limit(1)
        .get();
      return row ? hydrate(row) : null;
    },
    async readLatestRun(guildId, featureKey) {
      const row = await db
        .select()
        .from(featureSetupRuns)
        .where(
          and(eq(featureSetupRuns.guildId, guildId), eq(featureSetupRuns.featureKey, featureKey)),
        )
        .orderBy(desc(featureSetupRuns.createdAtMs))
        .limit(1)
        .get();
      return row ? hydrate(row) : null;
    },
    async readLatestResolution(guildId, featureKey, dependencyKey, resourceId) {
      const row = await db
        .select({ resolution: featureSetupResolutions })
        .from(featureSetupResolutions)
        .innerJoin(featureSetupRuns, eq(featureSetupRuns.id, featureSetupResolutions.runId))
        .where(
          and(
            eq(featureSetupRuns.guildId, guildId),
            eq(featureSetupRuns.featureKey, featureKey),
            eq(featureSetupResolutions.dependencyKey, dependencyKey),
            eq(featureSetupResolutions.resourceId, resourceId),
          ),
        )
        .orderBy(desc(featureSetupRuns.createdAtMs))
        .limit(1)
        .get();
      return row ? mapResolution(row.resolution) : null;
    },
    async createRun(run) {
      await db.insert(featureSetupRuns).values(runToRow(run)).run();
    },
    async updateRun(run) {
      await db
        .update(featureSetupRuns)
        .set(runToRow(run))
        .where(eq(featureSetupRuns.id, run.id))
        .run();
    },
    async upsertResolution(resolution) {
      const values = resolutionToRow(resolution);
      await db
        .insert(featureSetupResolutions)
        .values(values)
        .onConflictDoUpdate({
          target: [featureSetupResolutions.runId, featureSetupResolutions.dependencyKey],
          set: values,
        })
        .run();
    },
  };
  storeCache.set(database, store);
  return store;
}

function runToRow(run: SetupRun): typeof featureSetupRuns.$inferInsert {
  return {
    id: run.id,
    guildId: run.guildId,
    featureKey: run.featureKey,
    definitionVersion: run.definitionVersion,
    status: run.status,
    actorUserId: run.actorUserId,
    choicesJson: JSON.stringify(run.choices),
    failureDependencyKey: run.failureDependencyKey,
    failureMessage: run.failureMessage,
    pendingCreationDependencyKey: run.pendingCreationDependencyKey,
    createdAtMs: run.createdAtMs,
    updatedAtMs: run.updatedAtMs,
    completedAtMs: run.completedAtMs,
  };
}

function resolutionToRow(resolution: SetupResolution): typeof featureSetupResolutions.$inferInsert {
  return {
    runId: resolution.runId,
    dependencyKey: resolution.dependencyKey,
    resourceId: resolution.resource.id,
    resourceName: resolution.resource.name,
    resourceKind: resolution.resource.kind,
    relationship: resolution.relationship,
    templateVersion: resolution.templateVersion,
    validationStatus: resolution.validationStatus,
    validationDetail: resolution.validationDetail,
    appliedAtMs: resolution.appliedAtMs,
    createdAtMs: resolution.createdAtMs,
    updatedAtMs: resolution.updatedAtMs,
  };
}

function mapResolution(row: typeof featureSetupResolutions.$inferSelect): SetupResolution {
  return {
    runId: row.runId,
    dependencyKey: row.dependencyKey,
    resource: {
      id: row.resourceId,
      name: row.resourceName,
      kind: row.resourceKind as SetupResourceKind,
    },
    relationship: row.relationship as ResourceRelationship,
    templateVersion: row.templateVersion,
    validationStatus: row.validationStatus as SetupResolution["validationStatus"],
    validationDetail: row.validationDetail,
    appliedAtMs: row.appliedAtMs,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function parseChoices(value: string): Record<string, SetupResourceChoice> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};
    const choices: Record<string, SetupResourceChoice> = {};
    for (const [key, choice] of Object.entries(parsed)) {
      if (!isRecord(choice)) return {};
      if (choice.action === "reuse" && typeof choice.resourceId === "string") {
        choices[key] = { action: "reuse", resourceId: choice.resourceId };
      } else if (choice.action === "create" && typeof choice.name === "string") {
        choices[key] = { action: "create", name: choice.name };
      } else {
        return {};
      }
    }
    return choices;
  } catch {
    return {};
  }
}
