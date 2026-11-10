import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { marketplaceConfigs, marketplacePosts, marketplaceTradeLogs } from "../db/app-schema";
import type { MarketplaceBusinessLog, MarketplaceConfig, MarketplacePost } from "../types";
import { DEFAULT_MARKETPLACE_NOTICE_EMBED } from "../marketplace-config";
import type { MarketplaceStore } from "./contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";

type MarketplaceConfigRow = typeof marketplaceConfigs.$inferSelect;
type MarketplaceConfigInsert = typeof marketplaceConfigs.$inferInsert;
type MarketplacePostRow = typeof marketplacePosts.$inferSelect;
type MarketplacePostInsert = typeof marketplacePosts.$inferInsert;
type MarketplaceLogRow = typeof marketplaceTradeLogs.$inferSelect;
type MarketplaceLogInsert = typeof marketplaceTradeLogs.$inferInsert;

const marketplaceStoreCache = new WeakMap<D1Database, MarketplaceStore>();

export function createCloudflareMarketplaceStore(database: D1Database): MarketplaceStore {
  const cached = marketplaceStoreCache.get(database);
  if (cached) return cached;

  const db = createD1DrizzleDatabase(database);
  const store: MarketplaceStore = {
    async readMarketplaceConfig(guildId) {
      const row = await db
        .select()
        .from(marketplaceConfigs)
        .where(eq(marketplaceConfigs.guildId, guildId))
        .limit(1)
        .get();
      return row ? rowToConfig(row) : null;
    },

    async upsertMarketplaceConfig(config) {
      const values = configToRow(config);
      await db
        .insert(marketplaceConfigs)
        .values(values)
        .onConflictDoUpdate({
          target: marketplaceConfigs.guildId,
          set: {
            enabled: values.enabled,
            noticeChannelId: values.noticeChannelId,
            noticeMessageId: values.noticeMessageId,
            logChannelId: values.logChannelId,
            serverOptionsJson: values.serverOptionsJson,
            noticeEmbedJson: values.noticeEmbedJson,
            serverChoiceEnabled: values.serverChoiceEnabled,
            additionalChoicesEnabled: values.additionalChoicesEnabled,
            additionalChoicesJson: values.additionalChoicesJson,
            flowUpdatedAtMs: values.flowUpdatedAtMs,
            updatedAtMs: values.updatedAtMs,
          },
        })
        .run();
    },

    async refreshMarketplaceNotice(input) {
      const result = await db
        .update(marketplaceConfigs)
        .set({ noticeMessageId: input.messageId, updatedAtMs: input.updatedAtMs })
        .where(
          and(
            eq(marketplaceConfigs.guildId, input.guildId),
            eq(marketplaceConfigs.enabled, 1),
            eq(marketplaceConfigs.noticeChannelId, input.channelId),
            input.previousMessageId === null
              ? isNull(marketplaceConfigs.noticeMessageId)
              : eq(marketplaceConfigs.noticeMessageId, input.previousMessageId),
            eq(marketplaceConfigs.updatedAtMs, input.expectedUpdatedAtMs),
          ),
        )
        .run();
      return result.meta.changes === 1;
    },

    async listMarketplacePosts(guildId, options = {}) {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
      const rows = await db
        .select()
        .from(marketplacePosts)
        .where(
          options.activeOnly
            ? and(eq(marketplacePosts.guildId, guildId), eq(marketplacePosts.active, 1))
            : eq(marketplacePosts.guildId, guildId),
        )
        .orderBy(desc(marketplacePosts.createdAtMs))
        .limit(limit)
        .all();
      return rows.map(rowToPost);
    },

    async readMarketplacePost(guildId, postId) {
      const row = await db
        .select()
        .from(marketplacePosts)
        .where(and(eq(marketplacePosts.guildId, guildId), eq(marketplacePosts.postId, postId)))
        .limit(1)
        .get();
      return row ? rowToPost(row) : null;
    },

    async readActiveMarketplacePostByOwner(guildId, ownerId) {
      const row = await db
        .select()
        .from(marketplacePosts)
        .where(
          and(
            eq(marketplacePosts.guildId, guildId),
            eq(marketplacePosts.ownerId, ownerId),
            eq(marketplacePosts.active, 1),
          ),
        )
        .orderBy(desc(marketplacePosts.createdAtMs))
        .limit(1)
        .get();
      return row ? rowToPost(row) : null;
    },

    async createMarketplacePost(post) {
      await db.insert(marketplacePosts).values(postToRow(post)).run();
    },

    async updateMarketplacePostMessage(body) {
      await db
        .update(marketplacePosts)
        .set({ messageId: body.messageId })
        .where(
          and(eq(marketplacePosts.guildId, body.guildId), eq(marketplacePosts.postId, body.postId)),
        )
        .run();
    },

    async closeMarketplacePost(body) {
      const post = await this.readMarketplacePost(body.guildId, body.postId);
      if (!post || !post.active) throw new Error("Marketplace post is already closed or missing");
      await db
        .update(marketplacePosts)
        .set({
          active: 0,
          closedAtMs: body.closedAtMs,
          closedByUserId: body.closedByUserId,
        })
        .where(
          and(
            eq(marketplacePosts.guildId, body.guildId),
            eq(marketplacePosts.postId, body.postId),
            eq(marketplacePosts.active, 1),
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

    async listMarketplaceLogs(guildId, limit = 20) {
      const rows = await db
        .select()
        .from(marketplaceTradeLogs)
        .where(eq(marketplaceTradeLogs.guildId, guildId))
        .orderBy(desc(marketplaceTradeLogs.timestampMs))
        .limit(Math.min(Math.max(limit, 1), 100))
        .all();
      return rows.map(rowToLog);
    },

    async createMarketplaceLog(log) {
      await db.batch([
        db.insert(marketplaceTradeLogs).values(logToRow(log)),
        db
          .delete(marketplaceTradeLogs)
          .where(
            and(
              eq(marketplaceTradeLogs.guildId, log.guildId),
              notInArray(
                marketplaceTradeLogs.logId,
                db
                  .select({ logId: marketplaceTradeLogs.logId })
                  .from(marketplaceTradeLogs)
                  .where(eq(marketplaceTradeLogs.guildId, log.guildId))
                  .orderBy(desc(marketplaceTradeLogs.timestampMs))
                  .limit(1000),
              ),
            ),
          ),
      ]);
    },
  };

  marketplaceStoreCache.set(database, store);
  return store;
}

function rowToConfig(row: MarketplaceConfigRow): MarketplaceConfig {
  return {
    guildId: row.guildId,
    ...(row.enabled === 0 ? { enabled: false } : {}),
    noticeChannelId: row.noticeChannelId,
    noticeMessageId: row.noticeMessageId,
    logChannelId: row.logChannelId,
    serverOptions: JSON.parse(row.serverOptionsJson) as MarketplaceConfig["serverOptions"],
    noticeEmbed: row.noticeEmbedJson
      ? (JSON.parse(row.noticeEmbedJson) as NonNullable<MarketplaceConfig["noticeEmbed"]>)
      : { ...DEFAULT_MARKETPLACE_NOTICE_EMBED },
    serverChoiceEnabled: row.serverChoiceEnabled === undefined || row.serverChoiceEnabled === 1,
    additionalChoicesEnabled: row.additionalChoicesEnabled === 1,
    additionalChoices: JSON.parse(row.additionalChoicesJson ?? "[]") as NonNullable<
      MarketplaceConfig["additionalChoices"]
    >,
    flowUpdatedAtMs: row.flowUpdatedAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function configToRow(config: MarketplaceConfig): MarketplaceConfigInsert {
  return {
    guildId: config.guildId,
    enabled: config.enabled === false ? 0 : 1,
    noticeChannelId: config.noticeChannelId,
    noticeMessageId: config.noticeMessageId,
    logChannelId: config.logChannelId,
    serverOptionsJson: JSON.stringify(config.serverOptions),
    noticeEmbedJson: JSON.stringify(config.noticeEmbed ?? DEFAULT_MARKETPLACE_NOTICE_EMBED),
    serverChoiceEnabled: (config.serverChoiceEnabled ?? true) ? 1 : 0,
    additionalChoicesEnabled: (config.additionalChoicesEnabled ?? false) ? 1 : 0,
    additionalChoicesJson: JSON.stringify(config.additionalChoices ?? []),
    flowUpdatedAtMs: config.flowUpdatedAtMs ?? config.updatedAtMs,
    updatedAtMs: config.updatedAtMs,
  };
}

function rowToPost(row: MarketplacePostRow): MarketplacePost {
  return {
    guildId: row.guildId,
    id: row.postId,
    ownerId: row.ownerId,
    ownerDisplayName: row.ownerDisplayName,
    tradeType: row.tradeType as MarketplacePost["tradeType"],
    serverId: row.serverId,
    serverLabel: row.serverLabel,
    additionalChoices: JSON.parse(row.additionalChoicesJson ?? "[]") as NonNullable<
      MarketplacePost["additionalChoices"]
    >,
    have: row.have,
    want: row.want,
    extra: row.extra,
    channelId: row.channelId,
    messageId: row.messageId,
    active: row.active === 1,
    createdAtMs: row.createdAtMs,
    closedAtMs: row.closedAtMs,
    closedByUserId: row.closedByUserId,
  };
}

function postToRow(post: MarketplacePost): MarketplacePostInsert {
  return {
    guildId: post.guildId,
    postId: post.id,
    ownerId: post.ownerId,
    ownerDisplayName: post.ownerDisplayName,
    tradeType: post.tradeType,
    serverId: post.serverId,
    serverLabel: post.serverLabel,
    additionalChoicesJson: JSON.stringify(post.additionalChoices ?? []),
    have: post.have,
    want: post.want,
    extra: post.extra,
    channelId: post.channelId,
    messageId: post.messageId,
    active: post.active ? 1 : 0,
    createdAtMs: post.createdAtMs,
    closedAtMs: post.closedAtMs,
    closedByUserId: post.closedByUserId,
  };
}

function rowToLog(row: MarketplaceLogRow): MarketplaceBusinessLog {
  return {
    guildId: row.guildId,
    id: row.logId,
    timestampMs: row.timestampMs,
    buyerId: row.buyerId,
    buyerDisplayName: row.buyerDisplayName,
    sellerId: row.sellerId,
    postId: row.postId,
    channelId: row.channelId,
    messageId: row.messageId,
    tradeType: row.tradeType as MarketplaceBusinessLog["tradeType"],
    serverLabel: row.serverLabel,
    dmSent: row.dmSent === 1,
    dmError: row.dmError,
    have: row.have,
    want: row.want,
  };
}

function logToRow(log: MarketplaceBusinessLog): MarketplaceLogInsert {
  return {
    guildId: log.guildId,
    logId: log.id,
    timestampMs: log.timestampMs,
    buyerId: log.buyerId,
    buyerDisplayName: log.buyerDisplayName,
    sellerId: log.sellerId,
    postId: log.postId,
    channelId: log.channelId,
    messageId: log.messageId,
    tradeType: log.tradeType,
    serverLabel: log.serverLabel,
    dmSent: log.dmSent ? 1 : 0,
    dmError: log.dmError,
    have: log.have,
    want: log.want,
  };
}
