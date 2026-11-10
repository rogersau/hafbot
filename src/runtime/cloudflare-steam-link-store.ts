import type {
  GameOwnership,
  PendingSteamLink,
  SteamLink,
  SteamLinkConfig,
} from "./contracts/steam-link-store";
import { and, eq, lt } from "drizzle-orm";
import { pendingSteamLinks, steamLinkConfigs, steamLinks } from "../db/app-schema";
import type { SteamLinkStore } from "./contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";
import { DEFAULT_STEAM_LINK_CUSTOM_LINKS } from "./steam-link-custom-links";

type SteamLinkConfigRow = typeof steamLinkConfigs.$inferSelect;
type SteamLinkConfigInsert = typeof steamLinkConfigs.$inferInsert;
type PendingSteamLinkRow = typeof pendingSteamLinks.$inferSelect;
type PendingSteamLinkInsert = typeof pendingSteamLinks.$inferInsert;
type SteamLinkRow = typeof steamLinks.$inferSelect;
type SteamLinkInsert = typeof steamLinks.$inferInsert;

const steamLinkStoreCache = new WeakMap<D1Database, SteamLinkStore>();

export function createCloudflareSteamLinkStore(database: D1Database): SteamLinkStore {
  const cached = steamLinkStoreCache.get(database);
  if (cached) return cached;

  const db = createD1DrizzleDatabase(database);
  const store: SteamLinkStore = {
    async readSteamLinkConfig(guildId) {
      const row = await db
        .select()
        .from(steamLinkConfigs)
        .where(eq(steamLinkConfigs.guildId, guildId))
        .limit(1)
        .get();
      return row ? rowToConfig(row) : null;
    },

    async upsertSteamLinkConfig(config) {
      const values = configToRow(config);
      await db
        .insert(steamLinkConfigs)
        .values(values)
        .onConflictDoUpdate({
          target: steamLinkConfigs.guildId,
          set: {
            steamLinkedRoleId: values.steamLinkedRoleId,
            logChannelId: values.logChannelId,
            gameAppIdsJson: values.gameAppIdsJson,
            panelTitle: values.panelTitle,
            panelDescription: values.panelDescription,
            panelButtonLabel: values.panelButtonLabel,
            panelButtonStyle: values.panelButtonStyle,
            allowRelink: values.allowRelink,
            allowMultipleLinks: values.allowMultipleLinks,
            updatedAtMs: values.updatedAtMs,
            whoisFieldsJson: values.whoisFieldsJson,
            customLinksJson: values.customLinksJson,
            panelChannelId: values.panelChannelId,
            panelMessageId: values.panelMessageId,
          },
        })
        .run();
    },

    async createPendingSteamLink(pending) {
      await db.insert(pendingSteamLinks).values(pendingToRow(pending)).run();
    },

    async readPendingSteamLink(state) {
      const row = await db
        .select()
        .from(pendingSteamLinks)
        .where(eq(pendingSteamLinks.state, state))
        .limit(1)
        .get();
      return row ? rowToPending(row) : null;
    },

    async deletePendingSteamLink(state) {
      await db.delete(pendingSteamLinks).where(eq(pendingSteamLinks.state, state)).run();
    },

    async clearExpiredPendingSteamLinks(nowMs) {
      await db.delete(pendingSteamLinks).where(lt(pendingSteamLinks.createdAtMs, nowMs)).run();
    },

    async readSteamLink(guildId, userId) {
      const rows = await db
        .select()
        .from(steamLinks)
        .where(and(eq(steamLinks.guildId, guildId), eq(steamLinks.userId, userId)))
        .all();
      if (rows.length === 0) return null;
      const [mostRecent] = rows.sort((a, b) => b.linkedAtMs - a.linkedAtMs);
      return rowToLink(mostRecent);
    },

    async readSteamLinkEntry(guildId, userId, steamId64) {
      const row = await db
        .select()
        .from(steamLinks)
        .where(
          and(
            eq(steamLinks.guildId, guildId),
            eq(steamLinks.userId, userId),
            eq(steamLinks.steamId64, steamId64),
          ),
        )
        .limit(1)
        .get();
      return row ? rowToLink(row) : null;
    },

    async listSteamLinksByUser(guildId, userId) {
      const rows = await db
        .select()
        .from(steamLinks)
        .where(and(eq(steamLinks.guildId, guildId), eq(steamLinks.userId, userId)))
        .all();
      return rows.map(rowToLink);
    },

    async readSteamLinkBySteamId64(guildId, steamId64) {
      const row = await db
        .select()
        .from(steamLinks)
        .where(and(eq(steamLinks.guildId, guildId), eq(steamLinks.steamId64, steamId64)))
        .limit(1)
        .get();
      return row ? rowToLink(row) : null;
    },

    async upsertSteamLink(link) {
      const values = linkToRow(link);
      await db
        .insert(steamLinks)
        .values(values)
        .onConflictDoUpdate({
          target: [steamLinks.guildId, steamLinks.userId, steamLinks.steamId64],
          set: {
            linkedAtMs: values.linkedAtMs,
            manual: values.manual,
            actionedByUserId: values.actionedByUserId,
            gameOwnershipJson: values.gameOwnershipJson,
          },
        })
        .run();
    },

    async deleteSteamLink(guildId, userId) {
      await db
        .delete(steamLinks)
        .where(and(eq(steamLinks.guildId, guildId), eq(steamLinks.userId, userId)))
        .run();
    },

    async deleteSteamLinkBySteamId64(guildId, steamId64) {
      await db
        .delete(steamLinks)
        .where(and(eq(steamLinks.guildId, guildId), eq(steamLinks.steamId64, steamId64)))
        .run();
    },

    async listSteamLinks(guildId) {
      const rows = await db.select().from(steamLinks).where(eq(steamLinks.guildId, guildId)).all();
      return rows.map(rowToLink);
    },
  };

  steamLinkStoreCache.set(database, store);
  return store;
}

function rowToConfig(row: SteamLinkConfigRow): SteamLinkConfig | null {
  try {
    return {
      guildId: row.guildId,
      steamLinkedRoleId: row.steamLinkedRoleId,
      logChannelId: row.logChannelId,
      gameAppIds: JSON.parse(row.gameAppIdsJson ?? "[]") as number[],
      panelTitle: row.panelTitle,
      panelDescription: row.panelDescription,
      panelButtonLabel: row.panelButtonLabel,
      panelButtonStyle: row.panelButtonStyle,
      panelColor: row.panelColor ?? 0x5865f2,
      allowRelink: row.allowRelink !== 0,
      allowMultipleLinks: row.allowMultipleLinks === 1,
      whoisFields: JSON.parse(row.whoisFieldsJson ?? "[]") as string[],
      customLinks:
        row.customLinksJson === undefined || row.customLinksJson === null
          ? DEFAULT_STEAM_LINK_CUSTOM_LINKS
          : (JSON.parse(row.customLinksJson) as SteamLinkConfig["customLinks"]),
      panelChannelId: row.panelChannelId,
      panelMessageId: row.panelMessageId,
      updatedAtMs: row.updatedAtMs,
    };
  } catch {
    return null;
  }
}

function configToRow(config: SteamLinkConfig): SteamLinkConfigInsert {
  return {
    guildId: config.guildId,
    steamLinkedRoleId: config.steamLinkedRoleId,
    logChannelId: config.logChannelId,
    gameAppIdsJson: JSON.stringify(config.gameAppIds),
    panelTitle: config.panelTitle,
    panelDescription: config.panelDescription,
    panelButtonLabel: config.panelButtonLabel,
    panelButtonStyle: config.panelButtonStyle,
    panelColor: config.panelColor ?? 0x5865f2,
    allowRelink: config.allowRelink ? 1 : 0,
    allowMultipleLinks: config.allowMultipleLinks ? 1 : 0,
    updatedAtMs: config.updatedAtMs,
    whoisFieldsJson: JSON.stringify(config.whoisFields),
    customLinksJson: JSON.stringify(config.customLinks),
    panelChannelId: config.panelChannelId,
    panelMessageId: config.panelMessageId,
  };
}

function rowToPending(row: PendingSteamLinkRow): PendingSteamLink {
  return {
    state: row.state,
    guildId: row.guildId,
    userId: row.userId,
    createdAtMs: row.createdAtMs,
  };
}

function pendingToRow(pending: PendingSteamLink): PendingSteamLinkInsert {
  return {
    state: pending.state,
    guildId: pending.guildId,
    userId: pending.userId,
    createdAtMs: pending.createdAtMs,
  };
}

function rowToLink(row: SteamLinkRow): SteamLink {
  return {
    guildId: row.guildId,
    userId: row.userId,
    steamId64: row.steamId64,
    linkedAtMs: row.linkedAtMs,
    manual: row.manual !== 0,
    actionedByUserId: row.actionedByUserId,
    gameOwnership: parseGameOwnership(row.gameOwnershipJson),
  };
}

function linkToRow(link: SteamLink): SteamLinkInsert {
  return {
    guildId: link.guildId,
    userId: link.userId,
    steamId64: link.steamId64,
    linkedAtMs: link.linkedAtMs,
    manual: link.manual ? 1 : 0,
    actionedByUserId: link.actionedByUserId,
    gameOwnershipJson: link.gameOwnership ? JSON.stringify(link.gameOwnership) : null,
  };
}

function parseGameOwnership(json: string | null): GameOwnership[] {
  if (!json) return [];
  try {
    return JSON.parse(json) as GameOwnership[];
  } catch {
    return [];
  }
}
