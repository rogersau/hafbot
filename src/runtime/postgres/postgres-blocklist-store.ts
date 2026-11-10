import { and, asc, eq } from "drizzle-orm";

import {
  appConfig,
  guildBlockedEmojis,
  guildNotificationChannels,
  guildSettings,
} from "../../db/postgres/app-schema";
import type { BlocklistConfig, ChannelFilterMode } from "../../types";
import type { BlocklistStore } from "../contracts";
import type { PostgresDatabaseCapability } from "./postgres-capability";

type GuildSettingInsert = typeof guildSettings.$inferInsert;
type GuildSettingRow = typeof guildSettings.$inferSelect;
type GuildBlockedEmojiRow = typeof guildBlockedEmojis.$inferSelect;
type BlocklistGuildConfig = BlocklistConfig["guilds"][string];

export interface PostgresBlocklistStore extends BlocklistStore {
  applyGuildEmojiMutations(body: {
    guildId: string;
    emojis: string[];
    action: "add";
  }): Promise<BlocklistConfig>;
  upsertGuildChannelFilter(body: {
    guildId: string;
    channelMode: ChannelFilterMode;
    channelIds: string[];
  }): Promise<BlocklistConfig>;
  readGuildNotificationChannel(guildId: string, feature: string): Promise<string | null>;
  upsertGuildNotificationChannel(body: {
    guildId: string;
    feature: string;
    notificationChannelId: string | null;
  }): Promise<void>;
}

export function createPostgresBlocklistStore(
  database: PostgresDatabaseCapability,
  botUserId: string,
): PostgresBlocklistStore {
  const db = database.drizzle;
  return {
    async setGuildEnabled(guildId: string, enabled: boolean): Promise<void> {
      await db
        .insert(guildSettings)
        .values({ guildId, moderationEnabled: enabled })
        .onConflictDoUpdate({ target: guildSettings.guildId, set: { moderationEnabled: enabled } });
    },

    async readConfig() {
      const [guildRows, guildEmojiRows, appConfigRows] = await Promise.all([
        db.select().from(guildSettings).orderBy(asc(guildSettings.guildId)),
        db
          .select()
          .from(guildBlockedEmojis)
          .orderBy(asc(guildBlockedEmojis.guildId), asc(guildBlockedEmojis.normalizedEmoji)),
        db.select().from(appConfig),
      ]);

      const guilds: BlocklistConfig["guilds"] = {};
      for (const row of guildRows) guilds[row.guildId] = mapGuildSettingRow(row);
      for (const row of guildEmojiRows) appendBlockedEmojiRow(guilds, row);
      return {
        guilds,
        botUserId: appConfigRows.find((row) => row.key === "bot_user_id")?.value ?? botUserId,
      };
    },

    async readGuildConfig(guildId) {
      const [guildRows, guildEmojiRows, appConfigRows] = await Promise.all([
        db.select().from(guildSettings).where(eq(guildSettings.guildId, guildId)).limit(1),
        db
          .select()
          .from(guildBlockedEmojis)
          .where(eq(guildBlockedEmojis.guildId, guildId))
          .orderBy(asc(guildBlockedEmojis.normalizedEmoji)),
        db.select().from(appConfig).where(eq(appConfig.key, "bot_user_id")).limit(1),
      ]);

      const guilds: BlocklistConfig["guilds"] = {};
      for (const row of guildRows) guilds[row.guildId] = mapGuildSettingRow(row);
      for (const row of guildEmojiRows) appendBlockedEmojiRow(guilds, row);
      return {
        guilds,
        botUserId: appConfigRows[0]?.value ?? botUserId,
      };
    },

    async applyGuildEmojiMutation(body) {
      if (body.action === "add") {
        await db.transaction(async (transaction) => {
          await transaction
            .insert(guildSettings)
            .values({ guildId: body.guildId, moderationEnabled: true })
            .onConflictDoNothing();
          await transaction
            .insert(guildBlockedEmojis)
            .values({ guildId: body.guildId, normalizedEmoji: body.emoji })
            .onConflictDoNothing();
        });
      } else {
        await db
          .delete(guildBlockedEmojis)
          .where(
            and(
              eq(guildBlockedEmojis.guildId, body.guildId),
              eq(guildBlockedEmojis.normalizedEmoji, body.emoji),
            ),
          );
      }
      return this.readConfig();
    },

    async applyGuildEmojiMutations(body) {
      await db.transaction(async (transaction) => {
        await transaction
          .insert(guildSettings)
          .values({ guildId: body.guildId, moderationEnabled: true })
          .onConflictDoNothing();
        if (body.emojis.length > 0) {
          await transaction
            .insert(guildBlockedEmojis)
            .values(body.emojis.map((emoji) => ({ guildId: body.guildId, normalizedEmoji: emoji })))
            .onConflictDoNothing();
        }
      });
      return this.readConfig();
    },

    async upsertGuildChannelFilter(body) {
      const values: GuildSettingInsert = {
        guildId: body.guildId,
        moderationEnabled: true,
        channelMode: body.channelMode,
        channelIdsJson: JSON.stringify(body.channelIds),
      };
      await db
        .insert(guildSettings)
        .values(values)
        .onConflictDoUpdate({
          target: guildSettings.guildId,
          set: { channelMode: values.channelMode, channelIdsJson: values.channelIdsJson },
        });
      return this.readConfig();
    },

    async readGuildNotificationChannel(guildId, feature) {
      const rows = await db
        .select({ notificationChannelId: guildNotificationChannels.notificationChannelId })
        .from(guildNotificationChannels)
        .where(
          and(
            eq(guildNotificationChannels.guildId, guildId),
            eq(guildNotificationChannels.feature, feature),
          ),
        )
        .limit(1);
      return rows[0]?.notificationChannelId ?? null;
    },

    async upsertGuildNotificationChannel(body) {
      if (body.notificationChannelId === null) {
        await db
          .delete(guildNotificationChannels)
          .where(
            and(
              eq(guildNotificationChannels.guildId, body.guildId),
              eq(guildNotificationChannels.feature, body.feature),
            ),
          );
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
        });
    },
  };
}

function mapGuildSettingRow(row: GuildSettingRow): BlocklistGuildConfig {
  return {
    enabled: row.moderationEnabled,
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

function mapChannelMode(value: string | null | undefined): ChannelFilterMode {
  return value === "exclude" ? "exclude" : "include";
}

function mapChannelIds(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
