import type {
  MemberVerificationConfig,
  MemberVerificationState,
  MemberVerificationAttempt,
} from "../../../../src/types";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import {
  memberVerificationConfigs,
  memberVerificationStates,
  memberVerificationAttempts,
  memberVerificationManualDmRateLimits,
} from "../db/app-schema";
import type { MemberVerificationStore } from "../../../../src/runtime/contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";

type ConfigRow = typeof memberVerificationConfigs.$inferSelect;
type ConfigInsert = typeof memberVerificationConfigs.$inferInsert;
type StateRow = typeof memberVerificationStates.$inferSelect;
type StateInsert = typeof memberVerificationStates.$inferInsert;
type AttemptRow = typeof memberVerificationAttempts.$inferSelect;
type AttemptInsert = typeof memberVerificationAttempts.$inferInsert;

const memberVerificationStoreCache = new WeakMap<D1Database, MemberVerificationStore>();

export function createSqliteMemberVerificationStore(database: D1Database): MemberVerificationStore {
  const cached = memberVerificationStoreCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store: MemberVerificationStore = {
    async readConfig(guildId: string): Promise<MemberVerificationConfig | null> {
      const row = await db
        .select()
        .from(memberVerificationConfigs)
        .where(eq(memberVerificationConfigs.guildId, guildId))
        .get();
      return row ? rowToConfig(row) : null;
    },

    async upsertConfig(config: MemberVerificationConfig): Promise<void> {
      const values = configToRow(config);
      await db
        .insert(memberVerificationConfigs)
        .values(values)
        .onConflictDoUpdate({
          target: [memberVerificationConfigs.guildId],
          set: {
            enabled: values.enabled,
            verifiedRoleId: values.verifiedRoleId,
            title: values.title,
            description: values.description,
            color: values.color,
            imageUrl: values.imageUrl,
            thumbnailUrl: values.thumbnailUrl,
            rulesUrl: values.rulesUrl,
            verifyButtonEmoji: values.verifyButtonEmoji,
            deliveryMode: values.deliveryMode,
            verificationMethod: values.verificationMethod,
            welcomeChannelId: values.welcomeChannelId,
            panelMessageId: values.panelMessageId,
            updatedAtMs: values.updatedAtMs,
          },
        })
        .run();
    },

    async readVerificationState(
      guildId: string,
      userId: string,
    ): Promise<MemberVerificationState | null> {
      const row = await db
        .select()
        .from(memberVerificationStates)
        .where(
          and(
            eq(memberVerificationStates.guildId, guildId),
            eq(memberVerificationStates.userId, userId),
          ),
        )
        .get();
      return row ? rowToState(row) : null;
    },

    async upsertVerificationState(state: MemberVerificationState): Promise<void> {
      const values = stateToRow(state);
      await db
        .insert(memberVerificationStates)
        .values(values)
        .onConflictDoUpdate({
          target: [memberVerificationStates.guildId, memberVerificationStates.userId],
          set: {
            verifiedAtMs: values.verifiedAtMs,
          },
        })
        .run();
    },

    async createVerificationAttempt(attempt: MemberVerificationAttempt): Promise<void> {
      const values = attemptToRow(attempt);
      await db.insert(memberVerificationAttempts).values(values).run();
    },

    async readVerificationAttempt(id: string): Promise<MemberVerificationAttempt | null> {
      const row = await db
        .select()
        .from(memberVerificationAttempts)
        .where(eq(memberVerificationAttempts.id, id))
        .get();
      return row ? rowToAttempt(row) : null;
    },

    async updateVerificationAttempt(attempt: MemberVerificationAttempt): Promise<void> {
      const values = attemptToRow(attempt);
      await db
        .update(memberVerificationAttempts)
        .set(values)
        .where(eq(memberVerificationAttempts.id, attempt.id))
        .run();
    },

    async deleteVerificationAttempt(id: string): Promise<void> {
      await db
        .delete(memberVerificationAttempts)
        .where(eq(memberVerificationAttempts.id, id))
        .run();
    },

    async listActiveVerificationAttempts(
      guildId: string,
      userId: string,
    ): Promise<MemberVerificationAttempt[]> {
      const nowMs = Date.now();
      const rows = await db
        .select()
        .from(memberVerificationAttempts)
        .where(
          and(
            eq(memberVerificationAttempts.guildId, guildId),
            eq(memberVerificationAttempts.userId, userId),
            gt(memberVerificationAttempts.expiresAtMs, nowMs),
            isNull(memberVerificationAttempts.usedAtMs),
          ),
        )
        .orderBy(memberVerificationAttempts.createdAtMs)
        .all();
      return rows.map(rowToAttempt);
    },

    async tryClaimVerificationAttempt(id: string, nowMs: number): Promise<boolean> {
      const updated = await db
        .update(memberVerificationAttempts)
        .set({ usedAtMs: nowMs })
        .where(
          and(
            eq(memberVerificationAttempts.id, id),
            isNull(memberVerificationAttempts.usedAtMs),
            gt(memberVerificationAttempts.expiresAtMs, nowMs),
          ),
        )
        .returning()
        .get();
      return updated !== undefined && updated !== null;
    },

    async consumeManualDmRateLimit(input) {
      const key = {
        guildId: input.guildId,
        scopeType: input.scopeType,
        scopeId: input.scopeId,
      };
      await db
        .insert(memberVerificationManualDmRateLimits)
        .values({
          ...key,
          windowStartedAtMs: input.nowMs,
          attemptCount: 1,
          updatedAtMs: input.nowMs,
        })
        .onConflictDoUpdate({
          target: [
            memberVerificationManualDmRateLimits.guildId,
            memberVerificationManualDmRateLimits.scopeType,
            memberVerificationManualDmRateLimits.scopeId,
          ],
          set: {
            windowStartedAtMs: sql`CASE WHEN ${memberVerificationManualDmRateLimits.windowStartedAtMs} + ${input.windowMs} <= ${input.nowMs} THEN ${input.nowMs} ELSE ${memberVerificationManualDmRateLimits.windowStartedAtMs} END`,
            attemptCount: sql`CASE WHEN ${memberVerificationManualDmRateLimits.windowStartedAtMs} + ${input.windowMs} <= ${input.nowMs} THEN 1 ELSE MIN(${input.limit + 1}, ${memberVerificationManualDmRateLimits.attemptCount} + 1) END`,
            updatedAtMs: input.nowMs,
          },
        })
        .run();
      const row = await db
        .select({
          windowStartedAtMs: memberVerificationManualDmRateLimits.windowStartedAtMs,
          attemptCount: memberVerificationManualDmRateLimits.attemptCount,
        })
        .from(memberVerificationManualDmRateLimits)
        .where(
          and(
            eq(memberVerificationManualDmRateLimits.guildId, input.guildId),
            eq(memberVerificationManualDmRateLimits.scopeType, input.scopeType),
            eq(memberVerificationManualDmRateLimits.scopeId, input.scopeId),
          ),
        )
        .limit(1)
        .get();
      return {
        allowed: row !== undefined && row.attemptCount <= input.limit,
        retryAfterMs: Math.max(
          0,
          (row?.windowStartedAtMs ?? input.nowMs) + input.windowMs - input.nowMs,
        ),
      };
    },
  };

  memberVerificationStoreCache.set(database, store);
  return store;
}

function rowToConfig(row: ConfigRow): MemberVerificationConfig {
  return {
    guildId: row.guildId,
    enabled: row.enabled,
    verifiedRoleId: row.verifiedRoleId ?? null,
    title: row.title,
    description: row.description,
    color: row.color,
    imageUrl: row.imageUrl ?? null,
    thumbnailUrl: row.thumbnailUrl ?? null,
    rulesUrl: row.rulesUrl ?? null,
    verifyButtonEmoji: row.verifyButtonEmoji ?? null,
    deliveryMode: row.deliveryMode === "channel" ? "channel" : "dm",
    verificationMethod: normalizeVerificationMethod(row.verificationMethod),
    welcomeChannelId: row.welcomeChannelId ?? null,
    panelMessageId: row.panelMessageId ?? null,
    updatedAtMs: row.updatedAtMs,
  };
}

function normalizeVerificationMethod(
  value: string | null | undefined,
): MemberVerificationConfig["verificationMethod"] {
  if (value === "turnstile" || value === "steam-link") {
    return value;
  }
  return "discord-button";
}

function configToRow(config: MemberVerificationConfig): ConfigInsert {
  return {
    guildId: config.guildId,
    enabled: config.enabled,
    verifiedRoleId: config.verifiedRoleId,
    title: config.title,
    description: config.description,
    color: config.color,
    imageUrl: config.imageUrl,
    thumbnailUrl: config.thumbnailUrl,
    rulesUrl: config.rulesUrl,
    verifyButtonEmoji: config.verifyButtonEmoji,
    deliveryMode: config.deliveryMode,
    verificationMethod: config.verificationMethod,
    welcomeChannelId: config.welcomeChannelId,
    panelMessageId: config.panelMessageId,
    updatedAtMs: config.updatedAtMs,
  };
}

function rowToState(row: StateRow): MemberVerificationState {
  return {
    guildId: row.guildId,
    userId: row.userId,
    verifiedAtMs: row.verifiedAtMs,
  };
}

function stateToRow(state: MemberVerificationState): StateInsert {
  return {
    guildId: state.guildId,
    userId: state.userId,
    verifiedAtMs: state.verifiedAtMs,
  };
}

function rowToAttempt(row: AttemptRow): MemberVerificationAttempt {
  return {
    id: row.id,
    guildId: row.guildId,
    userId: row.userId,
    messageId: row.messageId ?? null,
    channelId: row.channelId ?? null,
    createdAtMs: row.createdAtMs,
    expiresAtMs: row.expiresAtMs,
    usedAtMs: row.usedAtMs ?? null,
  };
}

function attemptToRow(attempt: MemberVerificationAttempt): AttemptInsert {
  return {
    id: attempt.id,
    guildId: attempt.guildId,
    userId: attempt.userId,
    messageId: attempt.messageId,
    channelId: attempt.channelId,
    createdAtMs: attempt.createdAtMs,
    expiresAtMs: attempt.expiresAtMs,
    usedAtMs: attempt.usedAtMs,
  };
}
