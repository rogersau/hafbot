import type {
  ManualAssignmentTimedRoleConfig,
  NewMemberTimedRoleConfig,
  TimedRoleAutomationRule,
  TimedRoleAssignment,
} from "../types";
import { and, asc, eq, isNotNull, lte, or } from "drizzle-orm";
import { timedRoleConfigRules, timedRoles } from "../db/app-schema";
import type { TimedRoleStore } from "./contracts";
import type { TimedRoleConfigType } from "./contracts/timed-role-store";
import { createD1DrizzleDatabase } from "./drizzle-db";

type TimedRoleRow = typeof timedRoles.$inferSelect;
type TimedRoleInsert = typeof timedRoles.$inferInsert;
type TimedRoleConfigRuleRow = typeof timedRoleConfigRules.$inferSelect;

const timedRoleStoreCache = new WeakMap<D1Database, TimedRoleStore>();

export function createCloudflareTimedRoleStore(database: D1Database): TimedRoleStore {
  const cached = timedRoleStoreCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store: TimedRoleStore = {
    async listTimedRoles(): Promise<TimedRoleAssignment[]> {
      const rows = await db
        .select()
        .from(timedRoles)
        .orderBy(asc(timedRoles.guildId), asc(timedRoles.expiresAtMs))
        .all();

      return rows.map(rowToTimedRole);
    },

    async listTimedRolesByGuild(guildId: string): Promise<TimedRoleAssignment[]> {
      const rows = await db
        .select()
        .from(timedRoles)
        .where(eq(timedRoles.guildId, guildId))
        .orderBy(asc(timedRoles.expiresAtMs))
        .all();

      return rows.map(rowToTimedRole);
    },

    async upsertTimedRole(body: TimedRoleAssignment): Promise<void> {
      const now = Date.now();
      const values = timedRoleToRow(body, now);
      await db
        .insert(timedRoles)
        .values(values)
        .onConflictDoUpdate({
          target: [timedRoles.guildId, timedRoles.userId, timedRoles.roleId],
          set: {
            targetDisplayName: values.targetDisplayName,
            durationInput: values.durationInput,
            expiresAtMs: values.expiresAtMs,
            updatedAtMs: values.updatedAtMs,
          },
        })
        .run();
    },

    async updateTimedRoleSuspension(body): Promise<void> {
      await db
        .update(timedRoles)
        .set({
          pendingSuspensionRoleIdsJson: JSON.stringify(uniqueIds(body.pendingSuspensionRoleIds)),
          removedRoleIdsJson: JSON.stringify(uniqueIds(body.removedRoleIds)),
          pendingRestorationRoleIdsJson: JSON.stringify(uniqueIds(body.pendingRestorationRoleIds)),
          updatedAtMs: Date.now(),
        })
        .where(
          and(
            eq(timedRoles.guildId, body.guildId),
            eq(timedRoles.userId, body.userId),
            eq(timedRoles.roleId, body.roleId),
          ),
        )
        .run();
    },

    async updateTimedRoleRestoration(body): Promise<void> {
      await db
        .update(timedRoles)
        .set({
          pendingRestorationRoleIdsJson: JSON.stringify(uniqueIds(body.pendingRestorationRoleIds)),
          restorationStartedAtMs: body.restorationStartedAtMs,
          targetRoleRemovalCompletedAtMs: body.targetRoleRemovalCompletedAtMs,
          updatedAtMs: Date.now(),
        })
        .where(
          and(
            eq(timedRoles.guildId, body.guildId),
            eq(timedRoles.userId, body.userId),
            eq(timedRoles.roleId, body.roleId),
          ),
        )
        .run();
    },

    async deleteTimedRole(body: {
      guildId: string;
      userId: string;
      roleId: string;
    }): Promise<void> {
      await db
        .delete(timedRoles)
        .where(
          and(
            eq(timedRoles.guildId, body.guildId),
            eq(timedRoles.userId, body.userId),
            eq(timedRoles.roleId, body.roleId),
          ),
        )
        .run();
    },

    async listExpiredTimedRoles(nowMs: number): Promise<TimedRoleAssignment[]> {
      const rows = await db
        .select()
        .from(timedRoles)
        .where(or(lte(timedRoles.expiresAtMs, nowMs), isNotNull(timedRoles.restorationStartedAtMs)))
        .orderBy(asc(timedRoles.expiresAtMs))
        .all();

      return rows.map(rowToTimedRole);
    },

    async readTimedRoleConfigRules(
      guildId: string,
      configType: TimedRoleConfigType,
    ): Promise<TimedRoleAutomationRule[]> {
      const rows = await db
        .select()
        .from(timedRoleConfigRules)
        .where(
          and(
            eq(timedRoleConfigRules.guildId, guildId),
            eq(timedRoleConfigRules.configType, configType),
          ),
        )
        .orderBy(asc(timedRoleConfigRules.roleId))
        .all();

      return rows.map(rowToTimedRoleConfigRule).filter(isTimedRoleConfigRule);
    },

    async upsertTimedRoleConfigRules(
      guildId: string,
      configType: TimedRoleConfigType,
      rules: TimedRoleAutomationRule[],
    ): Promise<void> {
      await db
        .delete(timedRoleConfigRules)
        .where(
          and(
            eq(timedRoleConfigRules.guildId, guildId),
            eq(timedRoleConfigRules.configType, configType),
          ),
        )
        .run();

      if (rules.length === 0) {
        return;
      }

      await db
        .insert(timedRoleConfigRules)
        .values(rules.map((rule) => ruleToRow(guildId, configType, rule)))
        .run();
    },

    async readNewMemberTimedRoleConfig(guildId: string): Promise<NewMemberTimedRoleConfig> {
      return { guildId, roles: await store.readTimedRoleConfigRules!(guildId, "new-member") };
    },

    async upsertNewMemberTimedRoleConfig(body: NewMemberTimedRoleConfig): Promise<void> {
      await store.upsertTimedRoleConfigRules!(body.guildId, "new-member", body.roles);
    },

    async readManualAssignmentTimedRoleConfig(
      guildId: string,
    ): Promise<ManualAssignmentTimedRoleConfig> {
      return {
        guildId,
        roles: await store.readTimedRoleConfigRules!(guildId, "manual-assignment"),
      };
    },

    async upsertManualAssignmentTimedRoleConfig(
      body: ManualAssignmentTimedRoleConfig,
    ): Promise<void> {
      await store.upsertTimedRoleConfigRules!(body.guildId, "manual-assignment", body.roles);
    },
  };

  timedRoleStoreCache.set(database, store);
  return store;
}

function isTimedRoleConfigRule(rule: TimedRoleAutomationRule): boolean {
  return (
    typeof rule.roleId === "string" &&
    rule.roleId.trim().length > 0 &&
    typeof rule.durationInput === "string" &&
    rule.durationInput.trim().length > 0
  );
}

function rowToTimedRole(row: TimedRoleRow): TimedRoleAssignment {
  const assignment: TimedRoleAssignment = {
    guildId: row.guildId,
    userId: row.userId,
    roleId: row.roleId,
    durationInput: row.durationInput,
    expiresAtMs: row.expiresAtMs,
  };

  if (row.targetDisplayName != null) {
    assignment.targetDisplayName = row.targetDisplayName;
  }

  const suspendedRoleIds = parseIdList(row.suspendedRoleIdsJson);
  const pendingSuspensionRoleIds = parseIdList(row.pendingSuspensionRoleIdsJson);
  const removedRoleIds = parseIdList(row.removedRoleIdsJson);
  const pendingRestorationRoleIds = parseIdList(row.pendingRestorationRoleIdsJson);
  if (suspendedRoleIds.length > 0) assignment.suspendedRoleIds = suspendedRoleIds;
  if (pendingSuspensionRoleIds.length > 0) {
    assignment.pendingSuspensionRoleIds = pendingSuspensionRoleIds;
  }
  if (removedRoleIds.length > 0) assignment.removedRoleIds = removedRoleIds;
  if (pendingRestorationRoleIds.length > 0 || row.restorationStartedAtMs != null) {
    assignment.pendingRestorationRoleIds = pendingRestorationRoleIds;
  }
  if (row.restorationStartedAtMs != null) {
    assignment.restorationStartedAtMs = row.restorationStartedAtMs;
  }
  if (row.targetRoleRemovalCompletedAtMs != null) {
    assignment.targetRoleRemovalCompletedAtMs = row.targetRoleRemovalCompletedAtMs;
  }

  return assignment;
}

function timedRoleToRow(assignment: TimedRoleAssignment, now: number): TimedRoleInsert {
  return {
    guildId: assignment.guildId,
    userId: assignment.userId,
    roleId: assignment.roleId,
    targetDisplayName: assignment.targetDisplayName ?? null,
    durationInput: assignment.durationInput,
    expiresAtMs: assignment.expiresAtMs,
    suspendedRoleIdsJson: JSON.stringify(uniqueIds(assignment.suspendedRoleIds ?? [])),
    pendingSuspensionRoleIdsJson: JSON.stringify(
      uniqueIds(assignment.pendingSuspensionRoleIds ?? []),
    ),
    removedRoleIdsJson: JSON.stringify(uniqueIds(assignment.removedRoleIds ?? [])),
    pendingRestorationRoleIdsJson: JSON.stringify(
      uniqueIds(assignment.pendingRestorationRoleIds ?? assignment.removedRoleIds ?? []),
    ),
    restorationStartedAtMs: assignment.restorationStartedAtMs ?? null,
    targetRoleRemovalCompletedAtMs: assignment.targetRoleRemovalCompletedAtMs ?? null,
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function rowToTimedRoleConfigRule(row: TimedRoleConfigRuleRow): TimedRoleAutomationRule {
  return {
    ...(row.enabled === 0 ? { enabled: false } : {}),
    roleId: row.roleId,
    durationInput: row.durationInput,
    ...(row.dmMessage != null ? { dmMessage: row.dmMessage } : {}),
    ...(parseIdList(row.suspendedRoleIdsJson).length > 0
      ? { suspendedRoleIds: parseIdList(row.suspendedRoleIdsJson) }
      : {}),
  };
}

function ruleToRow(
  guildId: string,
  configType: TimedRoleConfigType,
  rule: TimedRoleAutomationRule,
): typeof timedRoleConfigRules.$inferInsert {
  return {
    guildId,
    configType,
    enabled: rule.enabled === false ? 0 : 1,
    roleId: rule.roleId,
    durationInput: rule.durationInput,
    dmMessage: rule.dmMessage ?? null,
    suspendedRoleIdsJson: JSON.stringify(uniqueIds(rule.suspendedRoleIds ?? [])),
    updatedAtMs: Date.now(),
  };
}

function parseIdList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? uniqueIds(parsed.filter((entry): entry is string => typeof entry === "string"))
      : [];
  } catch {
    return [];
  }
}

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}
