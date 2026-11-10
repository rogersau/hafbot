import type {
  PendingPlatformLink,
  PlatformLink,
  PlatformLinkConfig,
  PlatformLinkPlatform,
} from "./contracts/platform-link-store";
import { and, eq, lt, sql } from "drizzle-orm";
import {
  pendingPlatformLinks,
  platformLinkConfigs,
  platformLinks,
  steamLinks,
} from "../db/app-schema";
import type { PlatformLinkStore } from "./contracts/platform-link-store";
import { createD1DrizzleDatabase } from "./drizzle-db";
import { createCloudflareSteamLinkStore } from "./cloudflare-steam-link-store";
import type {
  PendingSteamLink,
  SteamLink,
  SteamLinkConfig,
  SteamLinkStore,
} from "./contracts/steam-link-store";

type PlatformLinkConfigRow = typeof platformLinkConfigs.$inferSelect;
type PlatformLinkConfigInsert = typeof platformLinkConfigs.$inferInsert;
type PendingPlatformLinkRow = typeof pendingPlatformLinks.$inferSelect;
type PendingPlatformLinkInsert = typeof pendingPlatformLinks.$inferInsert;
type PlatformLinkRow = typeof platformLinks.$inferSelect;
type PlatformLinkInsert = typeof platformLinks.$inferInsert;

const platformLinkStoreCache = new WeakMap<D1Database, PlatformLinkStore>();

export function createCloudflarePlatformLinkStore(database: D1Database): PlatformLinkStore {
  const cached = platformLinkStoreCache.get(database);
  if (cached) return cached;

  const db = createD1DrizzleDatabase(database);
  const primary: PlatformLinkStore = {
    async setPlatformLinkEnabled(
      guildId: string,
      platform: PlatformLinkPlatform,
      enabled: boolean,
    ): Promise<boolean> {
      const result = await db
        .update(platformLinkConfigs)
        .set({ enabled: enabled ? 1 : 0, updatedAtMs: Date.now() })
        .where(
          and(eq(platformLinkConfigs.guildId, guildId), eq(platformLinkConfigs.platform, platform)),
        )
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async readPlatformLinkConfig(guildId, platform) {
      const row = await db
        .select()
        .from(platformLinkConfigs)
        .where(
          and(eq(platformLinkConfigs.guildId, guildId), eq(platformLinkConfigs.platform, platform)),
        )
        .limit(1)
        .get();
      return row ? rowToConfig(row) : null;
    },

    async upsertPlatformLinkConfig(config) {
      const values = configToRow(config);
      await db
        .insert(platformLinkConfigs)
        .values(values)
        .onConflictDoUpdate({
          target: [platformLinkConfigs.guildId, platformLinkConfigs.platform],
          set: {
            linkedRoleId: values.linkedRoleId,
            logChannelId: values.logChannelId,
            gameAppIdsJson: values.gameAppIdsJson,
            panelTitle: values.panelTitle,
            panelDescription: values.panelDescription,
            panelButtonLabel: values.panelButtonLabel,
            panelButtonStyle: values.panelButtonStyle,
            allowRelink: values.allowRelink,
            allowMultipleLinks: values.allowMultipleLinks,
            requireRelinkOnRejoin: values.requireRelinkOnRejoin,
            updatedAtMs: values.updatedAtMs,
            whoisFieldsJson: values.whoisFieldsJson,
            customLinksJson: values.customLinksJson,
            panelChannelId: values.panelChannelId,
            panelMessageId: values.panelMessageId,
          },
        })
        .run();
    },

    async createPendingPlatformLink(pending) {
      await db.insert(pendingPlatformLinks).values(pendingToRow(pending)).run();
    },

    async readPendingPlatformLink(state) {
      const row = await db
        .select()
        .from(pendingPlatformLinks)
        .where(eq(pendingPlatformLinks.state, state))
        .limit(1)
        .get();
      return row ? rowToPending(row) : null;
    },

    async deletePendingPlatformLink(state) {
      await db.delete(pendingPlatformLinks).where(eq(pendingPlatformLinks.state, state)).run();
    },

    async clearExpiredPendingPlatformLinks(nowMs) {
      await db
        .delete(pendingPlatformLinks)
        .where(lt(pendingPlatformLinks.createdAtMs, nowMs))
        .run();
    },

    async readPlatformLink(guildId, userId, platform) {
      const row = await db
        .select()
        .from(platformLinks)
        .where(
          and(
            eq(platformLinks.guildId, guildId),
            eq(platformLinks.userId, userId),
            eq(platformLinks.platform, platform),
          ),
        )
        .limit(1)
        .get();
      return row ? rowToLink(row) : null;
    },

    async readPlatformLinkEntry(guildId, userId, platform, platformId) {
      const row = await db
        .select()
        .from(platformLinks)
        .where(
          and(
            eq(platformLinks.guildId, guildId),
            eq(platformLinks.userId, userId),
            eq(platformLinks.platform, platform),
            eq(platformLinks.platformId, platformId),
          ),
        )
        .limit(1)
        .get();
      return row ? rowToLink(row) : null;
    },

    async listPlatformLinksByUser(guildId, userId) {
      const rows = await db
        .select()
        .from(platformLinks)
        .where(and(eq(platformLinks.guildId, guildId), eq(platformLinks.userId, userId)))
        .all();
      return rows.map(rowToLink);
    },

    async readPlatformLinkByPlatformId(guildId, platform, platformId) {
      const row = await db
        .select()
        .from(platformLinks)
        .where(
          and(
            eq(platformLinks.guildId, guildId),
            eq(platformLinks.platform, platform),
            eq(platformLinks.platformId, platformId),
          ),
        )
        .limit(1)
        .get();
      return row ? rowToLink(row) : null;
    },

    async upsertPlatformLink(link) {
      const values = linkToRow(link);
      await db
        .insert(platformLinks)
        .values(values)
        .onConflictDoUpdate({
          target: [
            platformLinks.guildId,
            platformLinks.userId,
            platformLinks.platform,
            platformLinks.platformId,
          ],
          set: {
            linkedAtMs: values.linkedAtMs,
            manual: values.manual,
            actionedByUserId: values.actionedByUserId,
            metadataJson: values.metadataJson,
            active: values.active,
          },
        })
        .run();
    },

    async replacePlatformLinks(link) {
      const values = linkToRow(link);
      const removeCurrent = db
        .delete(platformLinks)
        .where(
          and(
            eq(platformLinks.guildId, link.guildId),
            eq(platformLinks.userId, link.userId),
            eq(platformLinks.platform, link.platform),
          ),
        );
      if (link.platform !== "steam") {
        await db.batch([removeCurrent, db.insert(platformLinks).values(values)]);
        return;
      }

      // Both representations share this database. A failed insert must roll back
      // both deletes. The legacy ownership guard also covers unmigrated accounts.
      await db.batch([
        removeCurrent,
        db
          .delete(steamLinks)
          .where(and(eq(steamLinks.guildId, link.guildId), eq(steamLinks.userId, link.userId))),
        db.insert(platformLinks).values({
          ...values,
          platformId: sql`CASE WHEN EXISTS (
            SELECT 1 FROM ${steamLinks}
            WHERE ${steamLinks.guildId} = ${link.guildId}
              AND ${steamLinks.steamId64} = ${link.platformId}
              AND ${steamLinks.userId} <> ${link.userId}
          ) THEN NULL ELSE ${link.platformId} END`,
        }),
      ]);
    },

    async deletePlatformLink(guildId, userId, platform, platformId) {
      if (platform && platformId) {
        await db
          .delete(platformLinks)
          .where(
            and(
              eq(platformLinks.guildId, guildId),
              eq(platformLinks.userId, userId),
              eq(platformLinks.platform, platform),
              eq(platformLinks.platformId, platformId),
            ),
          )
          .run();
      } else if (platform) {
        await db
          .delete(platformLinks)
          .where(
            and(
              eq(platformLinks.guildId, guildId),
              eq(platformLinks.userId, userId),
              eq(platformLinks.platform, platform),
            ),
          )
          .run();
      } else {
        await db
          .delete(platformLinks)
          .where(and(eq(platformLinks.guildId, guildId), eq(platformLinks.userId, userId)))
          .run();
      }
    },

    async listPlatformLinks(guildId, platform) {
      if (platform) {
        const rows = await db
          .select()
          .from(platformLinks)
          .where(and(eq(platformLinks.guildId, guildId), eq(platformLinks.platform, platform)))
          .all();
        return rows.map(rowToLink);
      }
      const rows = await db
        .select()
        .from(platformLinks)
        .where(eq(platformLinks.guildId, guildId))
        .all();
      return rows.map(rowToLink);
    },
  };

  const store = withLegacySteamFallback(primary, createCloudflareSteamLinkStore(database));
  platformLinkStoreCache.set(database, store);
  return store;
}

function withLegacySteamFallback(
  primary: PlatformLinkStore,
  legacy: SteamLinkStore,
): PlatformLinkStore {
  return {
    async readPlatformLinkConfig(guildId, platform) {
      const current = await primary.readPlatformLinkConfig(guildId, platform);
      if (current || platform !== "steam") return current;
      const fallback = await legacy.readSteamLinkConfig(guildId);
      return fallback ? legacyConfigToPlatform(fallback) : null;
    },
    async setPlatformLinkEnabled(guildId, platform, enabled) {
      if (!(await primary.readPlatformLinkConfig(guildId, platform)) && platform === "steam") {
        const fallback = await legacy.readSteamLinkConfig(guildId);
        if (fallback) await primary.upsertPlatformLinkConfig(legacyConfigToPlatform(fallback));
      }
      return primary.setPlatformLinkEnabled!(guildId, platform, enabled);
    },
    upsertPlatformLinkConfig: (config) => primary.upsertPlatformLinkConfig(config),
    createPendingPlatformLink: (pending) => primary.createPendingPlatformLink(pending),
    async readPendingPlatformLink(state) {
      const current = await primary.readPendingPlatformLink(state);
      if (current) return current;
      const fallback = await legacy.readPendingSteamLink(state);
      return fallback ? legacyPendingToPlatform(fallback) : null;
    },
    async deletePendingPlatformLink(state) {
      await Promise.all([
        primary.deletePendingPlatformLink(state),
        legacy.deletePendingSteamLink(state),
      ]);
    },
    async clearExpiredPendingPlatformLinks(nowMs) {
      await Promise.all([
        primary.clearExpiredPendingPlatformLinks(nowMs),
        legacy.clearExpiredPendingSteamLinks(nowMs),
      ]);
    },
    async readPlatformLink(guildId, userId, platform) {
      const current = await primary.readPlatformLink(guildId, userId, platform);
      if (current || platform !== "steam") return current;
      const fallback = await legacy.readSteamLink(guildId, userId);
      return fallback ? legacyLinkToPlatform(fallback) : null;
    },
    async readPlatformLinkEntry(guildId, userId, platform, platformId) {
      const current = await primary.readPlatformLinkEntry(guildId, userId, platform, platformId);
      if (current || platform !== "steam") return current;
      const fallback = await legacy.readSteamLinkEntry(guildId, userId, platformId);
      return fallback ? legacyLinkToPlatform(fallback) : null;
    },
    async listPlatformLinksByUser(guildId, userId) {
      return mergePlatformLinks(
        await primary.listPlatformLinksByUser(guildId, userId),
        (await legacy.listSteamLinksByUser(guildId, userId)).map(legacyLinkToPlatform),
      );
    },
    async readPlatformLinkByPlatformId(guildId, platform, platformId) {
      const current = await primary.readPlatformLinkByPlatformId(guildId, platform, platformId);
      if (current || platform !== "steam") return current;
      const fallback = await legacy.readSteamLinkBySteamId64(guildId, platformId);
      return fallback ? legacyLinkToPlatform(fallback) : null;
    },
    upsertPlatformLink: (link) => primary.upsertPlatformLink(link),
    replacePlatformLinks: (link) => primary.replacePlatformLinks(link),
    async deletePlatformLink(guildId, userId, platform, platformId) {
      await primary.deletePlatformLink(guildId, userId, platform, platformId);
      if (!platform || platform === "steam") {
        if (platformId) {
          await legacy.deleteSteamLinkBySteamId64(guildId, platformId);
        } else {
          await legacy.deleteSteamLink(guildId, userId);
        }
      }
    },
    async listPlatformLinks(guildId, platform) {
      const current = await primary.listPlatformLinks(guildId, platform);
      if (platform && platform !== "steam") return current;
      return mergePlatformLinks(
        current,
        (await legacy.listSteamLinks(guildId)).map(legacyLinkToPlatform),
      );
    },
  };
}

function legacyConfigToPlatform(config: SteamLinkConfig): PlatformLinkConfig {
  return {
    ...config,
    platform: "steam",
    linkedRoleId: config.steamLinkedRoleId,
    requireRelinkOnRejoin: false,
  };
}

function legacyPendingToPlatform(pending: PendingSteamLink): PendingPlatformLink {
  return { ...pending, platform: "steam" };
}

function legacyLinkToPlatform(link: SteamLink): PlatformLink {
  return {
    guildId: link.guildId,
    userId: link.userId,
    platform: "steam",
    platformId: link.steamId64,
    linkedAtMs: link.linkedAtMs,
    manual: link.manual,
    actionedByUserId: link.actionedByUserId,
    metadataJson: JSON.stringify(link.gameOwnership),
    active: true,
  };
}

function mergePlatformLinks(current: PlatformLink[], fallback: PlatformLink[]): PlatformLink[] {
  const links = new Map(
    current.map((link) => [
      `${link.guildId}:${link.userId}:${link.platform}:${link.platformId}`,
      link,
    ]),
  );
  for (const link of fallback) {
    const key = `${link.guildId}:${link.userId}:${link.platform}:${link.platformId}`;
    if (!links.has(key)) links.set(key, link);
  }
  return [...links.values()];
}

function rowToConfig(row: PlatformLinkConfigRow): PlatformLinkConfig | null {
  try {
    const platform = parsePlatform(row.platform);
    if (!platform) return null;
    return {
      guildId: row.guildId,
      platform,
      ...(row.enabled === 0 ? { enabled: false } : {}),
      linkedRoleId: row.linkedRoleId,
      logChannelId: row.logChannelId,
      gameAppIds: JSON.parse(row.gameAppIdsJson ?? "[]") as number[],
      panelTitle: row.panelTitle,
      panelDescription: row.panelDescription,
      panelButtonLabel: row.panelButtonLabel,
      panelButtonStyle: row.panelButtonStyle,
      panelColor:
        row.panelColor ??
        (platform === "xbox" ? 0x107c10 : platform === "playstation" ? 0x003791 : 0x5865f2),
      allowRelink: row.allowRelink !== 0,
      allowMultipleLinks: row.allowMultipleLinks === 1,
      requireRelinkOnRejoin: row.requireRelinkOnRejoin === 1,
      whoisFields: JSON.parse(row.whoisFieldsJson ?? "[]") as string[],
      customLinks:
        row.customLinksJson === undefined || row.customLinksJson === null
          ? []
          : (JSON.parse(row.customLinksJson) as PlatformLinkConfig["customLinks"]),
      panelChannelId: row.panelChannelId,
      panelMessageId: row.panelMessageId,
      updatedAtMs: row.updatedAtMs,
    };
  } catch {
    return null;
  }
}

function configToRow(config: PlatformLinkConfig): PlatformLinkConfigInsert {
  return {
    guildId: config.guildId,
    enabled: config.enabled === false ? 0 : 1,
    platform: config.platform,
    linkedRoleId: config.linkedRoleId,
    logChannelId: config.logChannelId,
    gameAppIdsJson: JSON.stringify(config.gameAppIds),
    panelTitle: config.panelTitle,
    panelDescription: config.panelDescription,
    panelButtonLabel: config.panelButtonLabel,
    panelButtonStyle: config.panelButtonStyle,
    panelColor:
      config.panelColor ??
      (config.platform === "xbox"
        ? 0x107c10
        : config.platform === "playstation"
          ? 0x003791
          : 0x5865f2),
    allowRelink: config.allowRelink ? 1 : 0,
    allowMultipleLinks: config.allowMultipleLinks ? 1 : 0,
    requireRelinkOnRejoin: config.requireRelinkOnRejoin ? 1 : 0,
    updatedAtMs: config.updatedAtMs,
    whoisFieldsJson: JSON.stringify(config.whoisFields),
    customLinksJson: JSON.stringify(config.customLinks),
    panelChannelId: config.panelChannelId,
    panelMessageId: config.panelMessageId,
  };
}

function rowToPending(row: PendingPlatformLinkRow): PendingPlatformLink {
  const platform = parsePlatform(row.platform);
  if (!platform) throw new Error(`Invalid platform: ${row.platform}`);
  return {
    state: row.state,
    guildId: row.guildId,
    userId: row.userId,
    platform,
    createdAtMs: row.createdAtMs,
  };
}

function pendingToRow(pending: PendingPlatformLink): PendingPlatformLinkInsert {
  return {
    state: pending.state,
    guildId: pending.guildId,
    userId: pending.userId,
    platform: pending.platform,
    createdAtMs: pending.createdAtMs,
  };
}

function rowToLink(row: PlatformLinkRow): PlatformLink {
  const platform = parsePlatform(row.platform);
  if (!platform) throw new Error(`Invalid platform: ${row.platform}`);
  return {
    guildId: row.guildId,
    userId: row.userId,
    platform,
    platformId: row.platformId,
    linkedAtMs: row.linkedAtMs,
    manual: row.manual !== 0,
    actionedByUserId: row.actionedByUserId,
    metadataJson: row.metadataJson,
    active: row.active !== 0,
  };
}

function parsePlatform(value: string): PlatformLinkPlatform | null {
  return value === "discord" ||
    value === "steam" ||
    value === "xbox" ||
    value === "playstation" ||
    value === "cftools"
    ? value
    : null;
}

function linkToRow(link: PlatformLink): PlatformLinkInsert {
  return {
    guildId: link.guildId,
    userId: link.userId,
    platform: link.platform,
    platformId: link.platformId,
    linkedAtMs: link.linkedAtMs,
    manual: link.manual ? 1 : 0,
    actionedByUserId: link.actionedByUserId,
    metadataJson: link.metadataJson,
    active: link.active ? 1 : 0,
  };
}
