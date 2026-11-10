import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  sql,
} from "drizzle-orm";
import { lfgApplications, lfgConfigs, lfgPosts, lfgVoiceChannels } from "../db/app-schema";
import type { LfgApplication, LfgConfig, LfgPost, LfgVoiceChannel } from "../types";
import type { LfgStore } from "./contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";

type LfgPostRow = typeof lfgPosts.$inferSelect;
type LfgPostInsert = typeof lfgPosts.$inferInsert;

const postSelect = {
  guildId: lfgPosts.guildId,
  postId: lfgPosts.postId,
  ownerId: lfgPosts.ownerId,
  ownerDisplayName: lfgPosts.ownerDisplayName,
  serverId: lfgPosts.serverId,
  serverLabel: lfgPosts.serverLabel,
  whenPlay: lfgPosts.whenPlay,
  lookingFor: lfgPosts.lookingFor,
  extraInfo: lfgPosts.extraInfo,
  channelId: lfgPosts.channelId,
  messageId: lfgPosts.messageId,
  active: lfgPosts.active,
  createdAtMs: lfgPosts.createdAtMs,
  expiresAtMs: lfgPosts.expiresAtMs,
  reminderSentAtMs: lfgPosts.reminderSentAtMs,
  renewedAtMs: lfgPosts.renewedAtMs,
  renewalsCount: lfgPosts.renewalsCount,
  closedAtMs: lfgPosts.closedAtMs,
  closedByUserId: lfgPosts.closedByUserId,
  scope: lfgPosts.scope,
  clanId: lfgPosts.clanId,
  clanTag: lfgPosts.clanTag,
  persistentVoiceChannelId: lfgPosts.persistentVoiceChannelId,
} satisfies Record<keyof LfgPostRow, unknown>;

const lfgStoreCache = new WeakMap<D1Database, LfgStore>();

export function createCloudflareLfgStore(database: D1Database): LfgStore {
  const cached = lfgStoreCache.get(database);
  if (cached) return cached;

  const drizzleDb = createD1DrizzleDatabase(database);
  const store: LfgStore = {
    async readLfgConfig(guildId) {
      const row = await drizzleDb
        .select()
        .from(lfgConfigs)
        .where(eq(lfgConfigs.guildId, guildId))
        .limit(1)
        .get();
      return row ? drizzleConfigToConfig(row) : null;
    },

    async upsertLfgConfig(config) {
      const values = configToDrizzleConfig(config);
      await drizzleDb
        .insert(lfgConfigs)
        .values(values)
        .onConflictDoUpdate({
          target: lfgConfigs.guildId,
          set: values,
        })
        .run();
    },

    async refreshLfgNotice(input) {
      const result = await drizzleDb
        .update(lfgConfigs)
        .set({ noticeMessageId: input.messageId, updatedAtMs: input.updatedAtMs })
        .where(
          and(
            eq(lfgConfigs.guildId, input.guildId),
            eq(lfgConfigs.enabled, 1),
            eq(lfgConfigs.noticeChannelId, input.channelId),
            input.previousMessageId === null
              ? isNull(lfgConfigs.noticeMessageId)
              : eq(lfgConfigs.noticeMessageId, input.previousMessageId),
            eq(lfgConfigs.updatedAtMs, input.expectedUpdatedAtMs),
          ),
        )
        .run();
      return result.meta.changes === 1;
    },

    async listLfgPosts(guildId, options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
      const rows = await drizzleDb
        .select()
        .from(lfgPosts)
        .where(
          options.activeOnly
            ? and(eq(lfgPosts.guildId, guildId), eq(lfgPosts.active, 1))
            : eq(lfgPosts.guildId, guildId),
        )
        .orderBy(desc(lfgPosts.createdAtMs))
        .limit(limit)
        .all();
      return rows.map(drizzlePostToPost);
    },

    async countActiveLfgPosts(guildId) {
      const row = await drizzleDb
        .select({ value: count() })
        .from(lfgPosts)
        .where(and(eq(lfgPosts.guildId, guildId), eq(lfgPosts.active, 1)))
        .get();
      return row?.value ?? 0;
    },

    async readLfgPost(guildId, postId) {
      const row = await drizzleDb
        .select()
        .from(lfgPosts)
        .where(and(eq(lfgPosts.guildId, guildId), eq(lfgPosts.postId, postId)))
        .limit(1)
        .get();
      return row ? drizzlePostToPost(row) : null;
    },

    async readActiveLfgPostByOwner(guildId, ownerId) {
      const row = await drizzleDb
        .select()
        .from(lfgPosts)
        .where(
          and(eq(lfgPosts.guildId, guildId), eq(lfgPosts.ownerId, ownerId), eq(lfgPosts.active, 1)),
        )
        .orderBy(desc(lfgPosts.createdAtMs))
        .limit(1)
        .get();
      return row ? drizzlePostToPost(row) : null;
    },

    async createLfgPost(post) {
      await drizzleDb.insert(lfgPosts).values(postToDrizzlePost(post)).run();
    },

    async updateLfgPostMessage(body) {
      await drizzleDb
        .update(lfgPosts)
        .set({ messageId: body.messageId })
        .where(and(eq(lfgPosts.guildId, body.guildId), eq(lfgPosts.postId, body.postId)))
        .run();
    },

    async updateLfgPost(post) {
      await drizzleDb
        .update(lfgPosts)
        .set({
          serverId: post.serverId,
          serverLabel: post.serverLabel,
          whenPlay: post.whenPlay,
          lookingFor: post.lookingFor,
          extraInfo: post.extraInfo,
          expiresAtMs: post.expiresAtMs,
          reminderSentAtMs: post.reminderSentAtMs,
          renewedAtMs: post.renewedAtMs,
          renewalsCount: post.renewalsCount,
          active: post.active ? 1 : 0,
          closedAtMs: post.closedAtMs,
          closedByUserId: post.closedByUserId,
        })
        .where(and(eq(lfgPosts.guildId, post.guildId), eq(lfgPosts.postId, post.id)))
        .run();
    },

    async closeLfgPost(body) {
      const post = await this.readLfgPost(body.guildId, body.postId);
      if (!post || !post.active) throw new Error("LFG post is already closed or missing");
      await drizzleDb
        .update(lfgPosts)
        .set({
          active: 0,
          closedAtMs: body.closedAtMs,
          closedByUserId: body.closedByUserId,
        })
        .where(
          and(
            eq(lfgPosts.guildId, body.guildId),
            eq(lfgPosts.postId, body.postId),
            eq(lfgPosts.active, 1),
          ),
        )
        .run();
      return {
        ...post,
        active: false,
        closedAtMs: body.closedAtMs,
        closedByUserId: body.closedByUserId,
      };
    },

    async createLfgApplication(application) {
      await drizzleDb
        .insert(lfgApplications)
        .values(applicationToDrizzleApplication(application))
        .run();
    },

    async readLfgApplication(guildId, postId, applicantId) {
      const row = await drizzleDb
        .select()
        .from(lfgApplications)
        .where(
          and(
            eq(lfgApplications.guildId, guildId),
            eq(lfgApplications.postId, postId),
            eq(lfgApplications.applicantId, applicantId),
          ),
        )
        .limit(1)
        .get();
      return row ? drizzleApplicationToApplication(row) : null;
    },

    async listLfgApplicationsForPost(guildId, postId, options = {}) {
      const where = options.status
        ? and(
            eq(lfgApplications.guildId, guildId),
            eq(lfgApplications.postId, postId),
            eq(lfgApplications.status, options.status),
          )
        : and(eq(lfgApplications.guildId, guildId), eq(lfgApplications.postId, postId));
      const rows = await drizzleDb
        .select()
        .from(lfgApplications)
        .where(where)
        .orderBy(desc(lfgApplications.createdAtMs))
        .all();
      return rows.map(drizzleApplicationToApplication);
    },

    async updateLfgApplication(application) {
      await drizzleDb
        .update(lfgApplications)
        .set({
          applicantDisplayName: application.applicantDisplayName,
          message: application.message,
          status: application.status,
          updatedAtMs: application.updatedAtMs,
          reviewedByUserId: application.reviewedByUserId,
          reviewedAtMs: application.reviewedAtMs,
        })
        .where(
          and(
            eq(lfgApplications.guildId, application.guildId),
            eq(lfgApplications.postId, application.postId),
            eq(lfgApplications.applicantId, application.applicantId),
          ),
        )
        .run();
    },

    async readLfgVoiceChannel(guildId, postId) {
      const row = await drizzleDb
        .select()
        .from(lfgVoiceChannels)
        .where(and(eq(lfgVoiceChannels.guildId, guildId), eq(lfgVoiceChannels.postId, postId)))
        .limit(1)
        .get();
      return row ? drizzleVoiceChannelToVoiceChannel(row) : null;
    },

    async readLfgVoiceChannelByChannelId(channelId) {
      const row = await drizzleDb
        .select()
        .from(lfgVoiceChannels)
        .where(eq(lfgVoiceChannels.channelId, channelId))
        .limit(1)
        .get();
      return row ? drizzleVoiceChannelToVoiceChannel(row) : null;
    },

    async upsertLfgVoiceChannel(channel) {
      await drizzleDb
        .insert(lfgVoiceChannels)
        .values(channel)
        .onConflictDoUpdate({
          target: [lfgVoiceChannels.guildId, lfgVoiceChannels.postId],
          set: {
            channelId: channel.channelId,
            updatedAtMs: channel.updatedAtMs,
          },
        })
        .run();
    },

    async deleteLfgVoiceChannel(guildId, postId) {
      await drizzleDb
        .delete(lfgVoiceChannels)
        .where(and(eq(lfgVoiceChannels.guildId, guildId), eq(lfgVoiceChannels.postId, postId)))
        .run();
    },

    async listDueLfgPostExpiries(nowMs, limit, excludedGuildIds = []) {
      const rows = await drizzleDb
        .select(postSelect)
        .from(lfgPosts)
        .leftJoin(lfgConfigs, eq(lfgConfigs.guildId, lfgPosts.guildId))
        .where(
          and(
            eq(lfgPosts.active, 1),
            isNotNull(lfgPosts.expiresAtMs),
            lte(lfgPosts.expiresAtMs, nowMs),
            ne(sql<string>`COALESCE(${lfgConfigs.expiryAction}, 'close')`, "nothing"),
            excludedGuildIds.length > 0
              ? notInArray(lfgPosts.guildId, [...excludedGuildIds])
              : undefined,
          ),
        )
        .orderBy(asc(lfgPosts.expiresAtMs))
        .limit(Math.min(Math.max(limit, 1), 100))
        .all();
      return rows.map(drizzlePostToPost);
    },

    async listDueLfgRenewalReminders(nowMs, limit, excludedGuildIds = []) {
      const reminderCutoffMs = nowMs + 60 * 60 * 1000;
      const rows = await drizzleDb
        .select()
        .from(lfgPosts)
        .where(
          and(
            eq(lfgPosts.active, 1),
            isNotNull(lfgPosts.expiresAtMs),
            lte(lfgPosts.expiresAtMs, reminderCutoffMs),
            gt(lfgPosts.expiresAtMs, nowMs),
            isNull(lfgPosts.reminderSentAtMs),
            excludedGuildIds.length > 0
              ? notInArray(lfgPosts.guildId, [...excludedGuildIds])
              : undefined,
          ),
        )
        .orderBy(asc(lfgPosts.expiresAtMs))
        .limit(Math.min(Math.max(limit, 1), 100))
        .all();
      return rows.map(drizzlePostToPost);
    },
  };

  lfgStoreCache.set(database, store);
  return store;
}

function drizzleConfigToConfig(row: typeof lfgConfigs.$inferSelect): LfgConfig {
  return {
    guildId: row.guildId,
    ...(row.enabled === 0 ? { enabled: false } : {}),
    noticeChannelId: row.noticeChannelId,
    noticeMessageId: row.noticeMessageId,
    notificationRoleId: row.notificationRoleId,
    noticeColor: row.noticeColor ?? 0x2b2d31,
    counterVoiceChannelId: row.counterVoiceChannelId,
    counterDisplayFormat: row.counterDisplayFormat ?? "LFG ({count})",
    approvalFlowEnabled: row.approvalFlowEnabled === 1,
    approvalAuditChannelId: row.approvalAuditChannelId,
    approvalVoiceCategoryId: row.approvalVoiceCategoryId,
    expiryAction: row.expiryAction as LfgConfig["expiryAction"],
    expiryDurationHours: row.expiryDurationHours,
    serverOptions: JSON.parse(row.serverOptionsJson) as LfgConfig["serverOptions"],
    updatedAtMs: row.updatedAtMs,
  };
}

function configToDrizzleConfig(config: LfgConfig): typeof lfgConfigs.$inferInsert {
  return {
    guildId: config.guildId,
    enabled: config.enabled === false ? 0 : 1,
    noticeChannelId: config.noticeChannelId,
    noticeMessageId: config.noticeMessageId,
    notificationRoleId: config.notificationRoleId,
    noticeColor: config.noticeColor ?? 0x2b2d31,
    counterVoiceChannelId: config.counterVoiceChannelId,
    counterDisplayFormat: config.counterDisplayFormat,
    approvalFlowEnabled: config.approvalFlowEnabled ? 1 : 0,
    approvalAuditChannelId: config.approvalAuditChannelId,
    approvalVoiceCategoryId: config.approvalVoiceCategoryId,
    expiryAction: config.expiryAction,
    expiryDurationHours: config.expiryDurationHours,
    serverOptionsJson: JSON.stringify(config.serverOptions),
    updatedAtMs: config.updatedAtMs,
  };
}

function applicationToDrizzleApplication(
  application: LfgApplication,
): typeof lfgApplications.$inferInsert {
  return application;
}

function drizzleApplicationToApplication(row: typeof lfgApplications.$inferSelect): LfgApplication {
  return {
    ...row,
    status: row.status as LfgApplication["status"],
  };
}

function drizzleVoiceChannelToVoiceChannel(
  row: typeof lfgVoiceChannels.$inferSelect,
): LfgVoiceChannel {
  return row;
}

function postToDrizzlePost(post: LfgPost): LfgPostInsert {
  return {
    guildId: post.guildId,
    postId: post.id,
    ownerId: post.ownerId,
    ownerDisplayName: post.ownerDisplayName,
    serverId: post.serverId,
    serverLabel: post.serverLabel,
    whenPlay: post.whenPlay,
    lookingFor: post.lookingFor,
    extraInfo: post.extraInfo,
    channelId: post.channelId,
    messageId: post.messageId,
    active: post.active ? 1 : 0,
    createdAtMs: post.createdAtMs,
    expiresAtMs: post.expiresAtMs,
    reminderSentAtMs: post.reminderSentAtMs,
    renewedAtMs: post.renewedAtMs,
    renewalsCount: post.renewalsCount,
    closedAtMs: post.closedAtMs,
    closedByUserId: post.closedByUserId,
    scope: post.scope ?? "public",
    clanId: post.clanId ?? null,
    clanTag: post.clanTag ?? null,
    persistentVoiceChannelId: post.persistentVoiceChannelId ?? null,
  };
}

function drizzlePostToPost(row: LfgPostRow): LfgPost {
  return {
    guildId: row.guildId,
    id: row.postId,
    ownerId: row.ownerId,
    ownerDisplayName: row.ownerDisplayName,
    serverId: row.serverId,
    serverLabel: row.serverLabel,
    whenPlay: row.whenPlay,
    lookingFor: row.lookingFor,
    extraInfo: row.extraInfo,
    channelId: row.channelId,
    messageId: row.messageId,
    active: row.active === 1,
    createdAtMs: row.createdAtMs,
    expiresAtMs: row.expiresAtMs,
    reminderSentAtMs: row.reminderSentAtMs,
    renewedAtMs: row.renewedAtMs,
    renewalsCount: row.renewalsCount,
    closedAtMs: row.closedAtMs,
    closedByUserId: row.closedByUserId,
    scope: row.scope as "public" | "clan",
    clanId: row.clanId,
    clanTag: row.clanTag,
    persistentVoiceChannelId: row.persistentVoiceChannelId,
  };
}
