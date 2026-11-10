import { and, eq } from "drizzle-orm";
import {
  appConfig,
  guildBlockedEmojis,
  guildNotificationChannels,
  guildSettings,
} from "../db/app-schema";
import type { BlocklistConfig, ChannelFilterMode } from "../types";
import type { BlocklistStore } from "./contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";

type GuildSettingInsert = typeof guildSettings.$inferInsert;
type GuildSettingRow = typeof guildSettings.$inferSelect;
type GuildBlockedEmojiInsert = typeof guildBlockedEmojis.$inferInsert;
type GuildBlockedEmojiRow = typeof guildBlockedEmojis.$inferSelect;
type AppConfigRow = typeof appConfig.$inferSelect;
type BlocklistGuildConfig = BlocklistConfig["guilds"][string];

const blocklistStoreCache = new WeakMap<
  D1Database,
  BlocklistStore & {
    readGuildNotificationChannel(guildId: string, feature: string): Promise<string | null>;
    upsertGuildNotificationChannel(body: {
      guildId: string;
      feature: string;
      notificationChannelId: string | null;
    }): Promise<void>;
  }
>();

export function createCloudflareBlocklistStore(database: D1Database, botUserId: string) {
  const cached = blocklistStoreCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store = {
    async setGuildEnabled(guildId: string, enabled: boolean): Promise<void> {
      await db
        .insert(guildSettings)
        .values({ guildId, moderationEnabled: enabled ? 1 : 0 })
        .onConflictDoUpdate({
          target: guildSettings.guildId,
          set: { moderationEnabled: enabled ? 1 : 0 },
        })
        .run();
    },

    async readConfig(): Promise<BlocklistConfig> {
      const [guildRows, guildEmojiRows, appConfigRows] = await Promise.all([
        db.select().from(guildSettings).all(),
        db.select().from(guildBlockedEmojis).all(),
        db.select().from(appConfig).all(),
      ]);

      return buildBlocklistConfig(guildRows, guildEmojiRows, appConfigRows, botUserId);
    },

    async readGuildConfig(guildId: string): Promise<BlocklistConfig> {
      const [guildRows, guildEmojiRows, appConfigRows] = await Promise.all([
        db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId)).limit(1).all(),
        db.select().from(guildBlockedEmojis).where(eq(guildBlockedEmojis.guildId, guildId)).all(),
        db.select().from(appConfig).where(eq(appConfig.key, "bot_user_id")).limit(1).all(),
      ]);

      return buildBlocklistConfig(guildRows, guildEmojiRows, appConfigRows, botUserId);
    },

    async applyGuildEmojiMutation(body: {
      guildId: string;
      emoji: string;
      action: "add" | "remove";
    }): Promise<BlocklistConfig> {
      if (body.action === "add") {
        const settingsValues: GuildSettingInsert = {
          guildId: body.guildId,
          moderationEnabled: 1,
        };
        const emojiValues: GuildBlockedEmojiInsert = {
          guildId: body.guildId,
          normalizedEmoji: body.emoji,
        };
        await db.insert(guildSettings).values(settingsValues).onConflictDoNothing().run();
        await db.insert(guildBlockedEmojis).values(emojiValues).onConflictDoNothing().run();
      } else {
        await db
          .delete(guildBlockedEmojis)
          .where(
            and(
              eq(guildBlockedEmojis.guildId, body.guildId),
              eq(guildBlockedEmojis.normalizedEmoji, body.emoji),
            ),
          )
          .run();
      }

      return this.readConfig();
    },

    async applyGuildEmojiMutations(body: {
      guildId: string;
      emojis: string[];
      action: "add";
    }): Promise<BlocklistConfig> {
      const settingsValues: GuildSettingInsert = {
        guildId: body.guildId,
        moderationEnabled: 1,
      };
      await db.batch([
        db.insert(guildSettings).values(settingsValues).onConflictDoNothing(),
        ...body.emojis.map((emoji) =>
          db
            .insert(guildBlockedEmojis)
            .values({ guildId: body.guildId, normalizedEmoji: emoji })
            .onConflictDoNothing(),
        ),
      ] as never);

      return this.readConfig();
    },

    async upsertGuildChannelFilter(body: {
      guildId: string;
      channelMode: ChannelFilterMode;
      channelIds: string[];
    }): Promise<BlocklistConfig> {
      const values: GuildSettingInsert = {
        guildId: body.guildId,
        moderationEnabled: 1,
        channelMode: body.channelMode,
        channelIdsJson: JSON.stringify(body.channelIds),
      };
      await db
        .insert(guildSettings)
        .values(values)
        .onConflictDoUpdate({
          target: guildSettings.guildId,
          set: {
            channelMode: values.channelMode,
            channelIdsJson: values.channelIdsJson,
          },
        })
        .run();

      return this.readConfig();
    },

    async readGuildNotificationChannel(guildId: string, feature: string): Promise<string | null> {
      const row = await db
        .select()
        .from(guildNotificationChannels)
        .where(
          and(
            eq(guildNotificationChannels.guildId, guildId),
            eq(guildNotificationChannels.feature, feature),
          ),
        )
        .limit(1)
        .get();

      return row?.notificationChannelId ?? null;
    },

    async upsertGuildNotificationChannel(body: {
      guildId: string;
      feature: string;
      notificationChannelId: string | null;
    }): Promise<void> {
      if (body.notificationChannelId === null) {
        await db
          .delete(guildNotificationChannels)
          .where(
            and(
              eq(guildNotificationChannels.guildId, body.guildId),
              eq(guildNotificationChannels.feature, body.feature),
            ),
          )
          .run();
        return;
      }

      await db
        .insert(guildNotificationChannels)
        .values({
          guildId: body.guildId,
          feature: body.feature,
          notificationChannelId: body.notificationChannelId,
        })
        .onConflictDoUpdate({
          target: [guildNotificationChannels.guildId, guildNotificationChannels.feature],
          set: { notificationChannelId: body.notificationChannelId },
        })
        .run();
    },
  };

  blocklistStoreCache.set(database, store);
  return store;
}

function buildBlocklistConfig(
  guildRows: GuildSettingRow[],
  guildEmojiRows: GuildBlockedEmojiRow[],
  appConfigRows: AppConfigRow[],
  fallbackBotUserId: string,
): BlocklistConfig {
  const guilds: BlocklistConfig["guilds"] = {};
  for (const row of guildRows) {
    guilds[row.guildId] = mapGuildSettingRow(row);
  }
  for (const row of guildEmojiRows) {
    appendBlockedEmojiRow(guilds, row);
  }

  return {
    guilds,
    botUserId: readBotUserId(appConfigRows, fallbackBotUserId),
  };
}

function mapGuildSettingRow(row: GuildSettingRow): BlocklistGuildConfig {
  return {
    enabled: row.moderationEnabled === 1,
    emojis: [],
    channelMode: mapChannelMode(row.channelMode),
    channelIds: mapChannelIds(row.channelIdsJson),
  };
}

function appendBlockedEmojiRow(guilds: BlocklistConfig["guilds"], row: GuildBlockedEmojiRow): void {
  guilds[row.guildId] ??= {
    enabled: true,
    emojis: [],
    channelMode: "include",
    channelIds: [],
  };
  guilds[row.guildId].emojis.push(row.normalizedEmoji);
}

function readBotUserId(rows: AppConfigRow[], fallback: string): string {
  return rows.find((row) => row.key === "bot_user_id")?.value ?? fallback;
}

function mapChannelMode(value: string | null | undefined): ChannelFilterMode {
  return value === "exclude" ? "exclude" : "include";
}

function mapChannelIds(value: string | null | undefined): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
