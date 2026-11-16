import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  consideredReplies,
  consideredReplyFlags,
  pendingSuggestionSubmissions,
  suggestionDigestRuns,
  suggestionActionRateLimits,
  suggestionRevisions,
  suggestions,
  suggestionsConfigs,
  suggestionStatusEvents,
  suggestionVotes,
} from "../db/app-schema";
import {
  type ConsideredReply,
  type Suggestion,
  type SuggestionAnswer,
  type SuggestionOutcome,
  type SuggestionPrompt,
  type SuggestionsConfig,
  type SuggestionStatus,
} from "../../../../src/suggestions";
import type { SuggestionStore } from "../../../../src/runtime/contracts/suggestion-store";
import { createD1DrizzleDatabase } from "./drizzle-db";

const ACTIVE = ["gathering_feedback", "needs_work", "under_review"];
const storeCache = new WeakMap<D1Database, SuggestionStore>();

export function createSqliteSuggestionStore(database: D1Database): SuggestionStore {
  const cached = storeCache.get(database);
  if (cached) return cached;
  const db = createD1DrizzleDatabase(database);
  const store: SuggestionStore = {
    async readConfig(guildId) {
      const row = await db
        .select()
        .from(suggestionsConfigs)
        .where(eq(suggestionsConfigs.guildId, guildId))
        .limit(1)
        .get();
      return row
        ? {
            guildId: row.guildId,
            enabled: row.enabled,
            forumChannelId: row.forumChannelId,
            panelChannelId: row.panelChannelId,
            panelMessageId: row.panelMessageId,
            panelTitle: row.panelTitle,
            panelBody: row.panelBody,
            panelButtonText: row.panelButtonText,
            prompts: json<SuggestionPrompt[]>(row.promptsJson, []),
            categories: json<string[]>(row.categoriesJson, []),
            statusTagIds: json<SuggestionsConfig["statusTagIds"]>(row.statusTagIdsJson, {}),
            categoryTagIds: json<Record<string, string>>(row.categoryTagIdsJson, {}),
            replyWebhookId: row.replyWebhookId,
            replyWebhookCredentialId: row.replyWebhookCredentialId,
            modRoleIds: json<string[]>(row.modRoleIdsJson, []),
            modQueueChannelId: row.modQueueChannelId,
            voterRoleId: row.voterRoleId,
            minimumTenureDays: row.minimumTenureDays,
            collapseThreshold: row.collapseThreshold,
            submissionCooldownSeconds: row.submissionCooldownSeconds,
            activeSuggestionLimit: row.activeSuggestionLimit,
            digestEnabled: row.digestEnabled,
            digestChannelId: row.digestChannelId,
            digestCadenceDays: row.digestCadenceDays,
            updatedAtMs: row.updatedAtMs,
          }
        : null;
    },
    async listDigestConfigs() {
      const rows = await db
        .select()
        .from(suggestionsConfigs)
        .where(eq(suggestionsConfigs.digestEnabled, true))
        .all();
      return rows.map((row) => ({
        guildId: row.guildId,
        enabled: row.enabled,
        forumChannelId: row.forumChannelId,
        panelChannelId: row.panelChannelId,
        panelMessageId: row.panelMessageId,
        panelTitle: row.panelTitle,
        panelBody: row.panelBody,
        panelButtonText: row.panelButtonText,
        prompts: json<SuggestionPrompt[]>(row.promptsJson, []),
        categories: json<string[]>(row.categoriesJson, []),
        statusTagIds: json<SuggestionsConfig["statusTagIds"]>(row.statusTagIdsJson, {}),
        categoryTagIds: json<Record<string, string>>(row.categoryTagIdsJson, {}),
        replyWebhookId: row.replyWebhookId,
        replyWebhookCredentialId: row.replyWebhookCredentialId,
        modRoleIds: json<string[]>(row.modRoleIdsJson, []),
        modQueueChannelId: row.modQueueChannelId,
        voterRoleId: row.voterRoleId,
        minimumTenureDays: row.minimumTenureDays,
        collapseThreshold: row.collapseThreshold,
        submissionCooldownSeconds: row.submissionCooldownSeconds,
        activeSuggestionLimit: row.activeSuggestionLimit,
        digestEnabled: row.digestEnabled,
        digestChannelId: row.digestChannelId,
        digestCadenceDays: row.digestCadenceDays,
        updatedAtMs: row.updatedAtMs,
      }));
    },
    async upsertConfig(config) {
      const row = configRow(config);
      await db
        .insert(suggestionsConfigs)
        .values(row)
        .onConflictDoUpdate({
          target: suggestionsConfigs.guildId,
          set: row,
        })
        .run();
    },
    async readSuggestion(guildId, suggestionId) {
      const row = await db
        .select()
        .from(suggestions)
        .where(and(eq(suggestions.guildId, guildId), eq(suggestions.id, suggestionId)))
        .limit(1)
        .get();
      return row ? mapSuggestion(row) : null;
    },
    async readSuggestionByThread(guildId, threadId) {
      const row = await db
        .select()
        .from(suggestions)
        .where(and(eq(suggestions.guildId, guildId), eq(suggestions.threadId, threadId)))
        .limit(1)
        .get();
      return row ? mapSuggestion(row) : null;
    },
    async listActiveSuggestions(guildId) {
      const rows = await db
        .select()
        .from(suggestions)
        .where(and(eq(suggestions.guildId, guildId), inArray(suggestions.status, ACTIVE)))
        .orderBy(desc(suggestions.updatedAtMs))
        .all();
      return rows.map(mapSuggestion);
    },
    async listSuggestions(guildId) {
      const rows = await db
        .select()
        .from(suggestions)
        .where(eq(suggestions.guildId, guildId))
        .orderBy(desc(suggestions.updatedAtMs))
        .all();
      return rows.map(mapSuggestion);
    },
    async listRevisions(guildId, suggestionId) {
      const rows = await db
        .select()
        .from(suggestionRevisions)
        .where(
          and(
            eq(suggestionRevisions.guildId, guildId),
            eq(suggestionRevisions.suggestionId, suggestionId),
          ),
        )
        .orderBy(desc(suggestionRevisions.revision))
        .all();
      return rows.map((row) => ({
        id: row.id,
        suggestionId: row.suggestionId,
        guildId: row.guildId,
        revision: row.revision,
        title: row.title,
        answers: json<SuggestionAnswer[]>(row.answersJson, []),
        category: row.category,
        editedByUserId: row.editedByUserId,
        createdAtMs: row.createdAtMs,
      }));
    },
    async listStatusEvents(guildId, suggestionId) {
      const rows = await db
        .select()
        .from(suggestionStatusEvents)
        .where(
          and(
            eq(suggestionStatusEvents.guildId, guildId),
            eq(suggestionStatusEvents.suggestionId, suggestionId),
          ),
        )
        .orderBy(desc(suggestionStatusEvents.createdAtMs))
        .all();
      return rows.map((row) => ({
        id: row.id,
        suggestionId: row.suggestionId,
        guildId: row.guildId,
        fromStatus: row.fromStatus as import("../../../../src/suggestions").SuggestionStatus,
        toStatus: row.toStatus as import("../../../../src/suggestions").SuggestionStatus,
        actorUserId: row.actorUserId,
        reason: row.reason,
        outcome: json<SuggestionOutcome | null>(row.outcomeJson, null),
        createdAtMs: row.createdAtMs,
      }));
    },
    async listConsideredReplies(guildId, suggestionId) {
      const rows = await db
        .select()
        .from(consideredReplies)
        .where(
          and(
            eq(consideredReplies.guildId, guildId),
            eq(consideredReplies.suggestionId, suggestionId),
          ),
        )
        .orderBy(desc(consideredReplies.createdAtMs))
        .all();
      return rows.map(mapReply);
    },
    async listVotes(guildId, suggestionId) {
      const rows = await db
        .select()
        .from(suggestionVotes)
        .where(
          and(eq(suggestionVotes.guildId, guildId), eq(suggestionVotes.suggestionId, suggestionId)),
        )
        .orderBy(desc(suggestionVotes.updatedAtMs))
        .all();
      return rows.map((row) => ({
        ...row,
        value: row.value as import("../../../../src/suggestions").SuggestionVoteValue,
      }));
    },
    async countActiveSuggestionsByAuthor(guildId, authorId) {
      const row = await db
        .select({ count: sql<number>`count(*)` })
        .from(suggestions)
        .where(
          and(
            eq(suggestions.guildId, guildId),
            eq(suggestions.authorId, authorId),
            inArray(suggestions.status, ACTIVE),
          ),
        )
        .get();
      return Number(row?.count ?? 0);
    },
    async readLatestSuggestionByAuthor(guildId, authorId) {
      const row = await db
        .select()
        .from(suggestions)
        .where(and(eq(suggestions.guildId, guildId), eq(suggestions.authorId, authorId)))
        .orderBy(desc(suggestions.createdAtMs))
        .limit(1)
        .get();
      return row ? mapSuggestion(row) : null;
    },
    async createSuggestion(suggestion) {
      await db.insert(suggestions).values(suggestionRow(suggestion)).run();
    },
    async updateSuggestion(suggestion, expectedRevision) {
      const result = await db
        .update(suggestions)
        .set(suggestionRow(suggestion))
        .where(
          and(
            eq(suggestions.guildId, suggestion.guildId),
            eq(suggestions.id, suggestion.id),
            eq(suggestions.revision, expectedRevision),
          ),
        )
        .run();
      return (result.meta.changes ?? 0) > 0;
    },
    async createRevision(revision) {
      await db
        .insert(suggestionRevisions)
        .values({
          ...revision,
          answersJson: JSON.stringify(revision.answers),
        })
        .run();
    },
    async appendStatusEvent(event) {
      await db
        .insert(suggestionStatusEvents)
        .values({
          id: event.id,
          suggestionId: event.suggestionId,
          guildId: event.guildId,
          fromStatus: event.fromStatus,
          toStatus: event.toStatus,
          actorUserId: event.actorUserId,
          reason: event.reason,
          outcomeJson: event.outcome ? JSON.stringify(event.outcome) : null,
          createdAtMs: event.createdAtMs,
        })
        .run();
    },
    async upsertVote(guildId, suggestionId, memberId, value, nowMs) {
      if (value === null) {
        await db
          .update(suggestionVotes)
          .set({ active: false, updatedAtMs: nowMs })
          .where(
            and(
              eq(suggestionVotes.suggestionId, suggestionId),
              eq(suggestionVotes.memberId, memberId),
            ),
          )
          .run();
        return null;
      }
      await db
        .insert(suggestionVotes)
        .values({
          guildId,
          suggestionId,
          memberId,
          value,
          active: true,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .onConflictDoUpdate({
          target: [suggestionVotes.suggestionId, suggestionVotes.memberId],
          set: { value, active: true, updatedAtMs: nowMs },
        })
        .run();
      return {
        guildId,
        suggestionId,
        memberId,
        value,
        active: true,
        createdAtMs: nowMs,
        updatedAtMs: nowMs,
      };
    },
    async deactivateVotesForMember(guildId, memberId, nowMs) {
      const result = await db
        .update(suggestionVotes)
        .set({ active: false, updatedAtMs: nowMs })
        .where(
          and(
            eq(suggestionVotes.guildId, guildId),
            eq(suggestionVotes.memberId, memberId),
            eq(suggestionVotes.active, true),
          ),
        )
        .run();
      return result.meta.changes ?? 0;
    },
    async recountVotes(guildId, suggestionId) {
      const rows = await db
        .select({
          value: suggestionVotes.value,
          count: sql<number>`count(*)`,
        })
        .from(suggestionVotes)
        .where(
          and(
            eq(suggestionVotes.guildId, guildId),
            eq(suggestionVotes.suggestionId, suggestionId),
            eq(suggestionVotes.active, true),
          ),
        )
        .groupBy(suggestionVotes.value)
        .all();
      return {
        support: Number(rows.find((row) => row.value === "support")?.count ?? 0),
        oppose: Number(rows.find((row) => row.value === "oppose")?.count ?? 0),
      };
    },
    async createConsideredReply(reply) {
      await db.insert(consideredReplies).values(replyRow(reply)).run();
    },
    async readConsideredReplyById(replyId) {
      const row = await db
        .select()
        .from(consideredReplies)
        .where(eq(consideredReplies.id, replyId))
        .limit(1)
        .get();
      return row ? mapReply(row) : null;
    },
    async readConsideredReply(guildId, replyId) {
      const row = await db
        .select()
        .from(consideredReplies)
        .where(and(eq(consideredReplies.guildId, guildId), eq(consideredReplies.id, replyId)))
        .limit(1)
        .get();
      return row ? mapReply(row) : null;
    },
    async readConsideredReplyByMessage(guildId, messageId) {
      const row = await db
        .select()
        .from(consideredReplies)
        .where(
          and(
            eq(consideredReplies.guildId, guildId),
            eq(consideredReplies.webhookMessageId, messageId),
          ),
        )
        .limit(1)
        .get();
      return row ? mapReply(row) : null;
    },
    async updateConsideredReply(reply, expectedState) {
      const result = await db
        .update(consideredReplies)
        .set(replyRow(reply))
        .where(
          and(
            eq(consideredReplies.guildId, reply.guildId),
            eq(consideredReplies.id, reply.id),
            eq(consideredReplies.state, expectedState),
          ),
        )
        .run();
      return (result.meta.changes ?? 0) > 0;
    },
    async setReplyFlag(guildId, replyId, memberId, active, nowMs) {
      await db
        .insert(consideredReplyFlags)
        .values({
          guildId,
          replyId,
          memberId,
          active,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .onConflictDoUpdate({
          target: [consideredReplyFlags.replyId, consideredReplyFlags.memberId],
          set: { active, updatedAtMs: nowMs },
        })
        .run();
    },
    async countReplyFlags(guildId, replyId) {
      const row = await db
        .select({ count: sql<number>`count(*)` })
        .from(consideredReplyFlags)
        .where(
          and(
            eq(consideredReplyFlags.guildId, guildId),
            eq(consideredReplyFlags.replyId, replyId),
            eq(consideredReplyFlags.active, true),
          ),
        )
        .get();
      return Number(row?.count ?? 0);
    },
    async listReplyFlagMemberIds(guildId, replyId) {
      const rows = await db
        .select({ memberId: consideredReplyFlags.memberId })
        .from(consideredReplyFlags)
        .where(
          and(
            eq(consideredReplyFlags.guildId, guildId),
            eq(consideredReplyFlags.replyId, replyId),
            eq(consideredReplyFlags.active, true),
          ),
        )
        .all();
      return rows.map((row) => row.memberId);
    },
    async savePendingSubmission(pending) {
      await db
        .insert(pendingSuggestionSubmissions)
        .values({
          id: pending.id,
          guildId: pending.guildId,
          authorId: pending.authorId,
          title: pending.title,
          answersJson: JSON.stringify(pending.answers),
          category: pending.category,
          likelyDuplicateIdsJson: JSON.stringify(pending.likelyDuplicateIds),
          expiresAtMs: pending.expiresAtMs,
        })
        .onConflictDoUpdate({
          target: pendingSuggestionSubmissions.id,
          set: {
            title: pending.title,
            answersJson: JSON.stringify(pending.answers),
            category: pending.category,
            likelyDuplicateIdsJson: JSON.stringify(pending.likelyDuplicateIds),
            expiresAtMs: pending.expiresAtMs,
          },
        })
        .run();
    },
    async readPendingSubmission(id) {
      const row = await db
        .select()
        .from(pendingSuggestionSubmissions)
        .where(eq(pendingSuggestionSubmissions.id, id))
        .limit(1)
        .get();
      return row
        ? {
            id: row.id,
            guildId: row.guildId,
            authorId: row.authorId,
            title: row.title,
            answers: json<SuggestionAnswer[]>(row.answersJson, []),
            category: row.category,
            likelyDuplicateIds: json<string[]>(row.likelyDuplicateIdsJson, []),
            expiresAtMs: row.expiresAtMs,
          }
        : null;
    },
    async deletePendingSubmission(id) {
      await db
        .delete(pendingSuggestionSubmissions)
        .where(eq(pendingSuggestionSubmissions.id, id))
        .run();
    },
    async reserveDigestRun(guildId, periodKey, nowMs) {
      const existing = await db
        .select()
        .from(suggestionDigestRuns)
        .where(
          and(
            eq(suggestionDigestRuns.guildId, guildId),
            eq(suggestionDigestRuns.periodKey, periodKey),
          ),
        )
        .limit(1)
        .get();
      if (existing?.status === "delivered") return false;
      if (existing) {
        await db
          .update(suggestionDigestRuns)
          .set({ status: "pending", updatedAtMs: nowMs })
          .where(
            and(
              eq(suggestionDigestRuns.guildId, guildId),
              eq(suggestionDigestRuns.periodKey, periodKey),
            ),
          )
          .run();
        return true;
      }
      const result = await db
        .insert(suggestionDigestRuns)
        .values({
          guildId,
          periodKey,
          status: "pending",
          deliveredMessageId: null,
          createdAtMs: nowMs,
          updatedAtMs: nowMs,
        })
        .onConflictDoNothing()
        .run();
      return (result.meta.changes ?? 0) > 0;
    },
    async completeDigestRun(guildId, periodKey, deliveredMessageId, nowMs) {
      await db
        .update(suggestionDigestRuns)
        .set({
          status: "delivered",
          deliveredMessageId,
          updatedAtMs: nowMs,
        })
        .where(
          and(
            eq(suggestionDigestRuns.guildId, guildId),
            eq(suggestionDigestRuns.periodKey, periodKey),
          ),
        )
        .run();
    },
    async consumeActionRateLimit(guildId, actorUserId, action, windowStartMs, limit, nowMs) {
      await db
        .insert(suggestionActionRateLimits)
        .values({
          guildId,
          actorUserId,
          action,
          windowStartMs,
          count: 1,
          updatedAtMs: nowMs,
        })
        .onConflictDoUpdate({
          target: [
            suggestionActionRateLimits.guildId,
            suggestionActionRateLimits.actorUserId,
            suggestionActionRateLimits.action,
            suggestionActionRateLimits.windowStartMs,
          ],
          set: {
            count: sql`${suggestionActionRateLimits.count} + 1`,
            updatedAtMs: nowMs,
          },
        })
        .run();
      const row = await db
        .select({ count: suggestionActionRateLimits.count })
        .from(suggestionActionRateLimits)
        .where(
          and(
            eq(suggestionActionRateLimits.guildId, guildId),
            eq(suggestionActionRateLimits.actorUserId, actorUserId),
            eq(suggestionActionRateLimits.action, action),
            eq(suggestionActionRateLimits.windowStartMs, windowStartMs),
          ),
        )
        .limit(1)
        .get();
      return Number(row?.count ?? limit + 1) <= limit;
    },
  };
  storeCache.set(database, store);
  return store;
}

type SuggestionRow = typeof suggestions.$inferSelect;
type ReplyRow = typeof consideredReplies.$inferSelect;

function configRow(config: SuggestionsConfig): typeof suggestionsConfigs.$inferInsert {
  return {
    ...config,
    promptsJson: JSON.stringify(config.prompts),
    categoriesJson: JSON.stringify(config.categories),
    modRoleIdsJson: JSON.stringify(config.modRoleIds),
    statusTagIdsJson: JSON.stringify(config.statusTagIds),
    categoryTagIdsJson: JSON.stringify(config.categoryTagIds),
  };
}

function suggestionRow(value: Suggestion): typeof suggestions.$inferInsert {
  return {
    ...value,
    answersJson: JSON.stringify(value.answers),
    outcomeJson: value.outcome ? JSON.stringify(value.outcome) : null,
  };
}

function mapSuggestion(row: SuggestionRow): Suggestion {
  return {
    id: row.id,
    guildId: row.guildId,
    authorId: row.authorId,
    title: row.title,
    normalizedSearchText: row.normalizedSearchText,
    answers: json<SuggestionAnswer[]>(row.answersJson, []),
    category: row.category,
    status: row.status as SuggestionStatus,
    revision: row.revision,
    threadId: row.threadId,
    starterMessageId: row.starterMessageId,
    projectionError: row.projectionError,
    supportCount: row.supportCount,
    opposeCount: row.opposeCount,
    outcome: row.outcomeJson ? json<SuggestionOutcome | null>(row.outcomeJson, null) : null,
    createdAtMs: row.createdAtMs,
    editedAtMs: row.editedAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function replyRow(value: ConsideredReply): typeof consideredReplies.$inferInsert {
  return value;
}

function mapReply(row: ReplyRow): ConsideredReply {
  return row as ConsideredReply;
}

function json<T>(value: string | null, fallback: T): T {
  if (value === null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
