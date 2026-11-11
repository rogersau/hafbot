import type { PlatformLinkPlatform } from "../../../../src/runtime/contracts/platform-link-store";
import { and, eq, lt } from "drizzle-orm";
import { pendingPlatformLinks, platformLinkConfigs, platformLinks } from "../db/app-schema";
import type { PlatformLinkStore } from "../../../../src/runtime/contracts/platform-link-store";
import { createD1DrizzleDatabase } from "./drizzle-db";

import {
  rowToConfig,
  configToRow,
  rowToPending,
  pendingToRow,
  rowToLink,
  linkToRow,
} from "../../../../src/runtime/platform-link-records";

const platformLinkStoreCache = new WeakMap<D1Database, PlatformLinkStore>();

export function createSqlitePlatformLinkStore(database: D1Database): PlatformLinkStore {
  const cached = platformLinkStoreCache.get(database);
  if (cached) return cached;

  const db = createD1DrizzleDatabase(database);
  const store: PlatformLinkStore = {
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
            panelColor: values.panelColor,
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
      await db.batch([removeCurrent, db.insert(platformLinks).values(values)]);
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

  platformLinkStoreCache.set(database, store);
  return store;
}
