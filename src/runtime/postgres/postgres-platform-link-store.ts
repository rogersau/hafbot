import type { PlatformLinkPlatform } from "../contracts/platform-link-store";
import { and, eq, lt } from "drizzle-orm";
import {
  pendingPlatformLinks,
  platformLinkConfigs,
  platformLinks,
} from "../../db/postgres/app-schema";
import type { PlatformLinkStore } from "../contracts/platform-link-store";
import type { PostgresDatabaseCapability } from "./postgres-capability";

import {
  rowToConfig,
  configToRow,
  rowToPending,
  pendingToRow,
  rowToLink,
  linkToRow,
} from "../platform-link-records";

export function createPostgresPlatformLinkStore(
  database: PostgresDatabaseCapability,
): PlatformLinkStore {
  const db = database.drizzle;
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
        .execute();
      return (result.rowCount ?? 0) > 0;
    },

    async readPlatformLinkConfig(guildId, platform) {
      const row = await db
        .select()
        .from(platformLinkConfigs)
        .where(
          and(eq(platformLinkConfigs.guildId, guildId), eq(platformLinkConfigs.platform, platform)),
        )
        .limit(1)
        .then((rows) => rows[0]);
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
        .execute();
    },

    async createPendingPlatformLink(pending) {
      await db.insert(pendingPlatformLinks).values(pendingToRow(pending)).execute();
    },

    async readPendingPlatformLink(state) {
      const row = await db
        .select()
        .from(pendingPlatformLinks)
        .where(eq(pendingPlatformLinks.state, state))
        .limit(1)
        .then((rows) => rows[0]);
      return row ? rowToPending(row) : null;
    },

    async deletePendingPlatformLink(state) {
      await db.delete(pendingPlatformLinks).where(eq(pendingPlatformLinks.state, state)).execute();
    },

    async clearExpiredPendingPlatformLinks(nowMs) {
      await db
        .delete(pendingPlatformLinks)
        .where(lt(pendingPlatformLinks.createdAtMs, nowMs))
        .execute();
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
        .then((rows) => rows[0]);
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
        .then((rows) => rows[0]);
      return row ? rowToLink(row) : null;
    },

    async listPlatformLinksByUser(guildId, userId) {
      const rows = await db
        .select()
        .from(platformLinks)
        .where(and(eq(platformLinks.guildId, guildId), eq(platformLinks.userId, userId)));
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
        .then((rows) => rows[0]);
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
        .execute();
    },

    async replacePlatformLinks(link) {
      await db.transaction(async (transaction) => {
        await transaction
          .delete(platformLinks)
          .where(
            and(
              eq(platformLinks.guildId, link.guildId),
              eq(platformLinks.userId, link.userId),
              eq(platformLinks.platform, link.platform),
            ),
          );
        await transaction.insert(platformLinks).values(linkToRow(link));
      });
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
          .execute();
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
          .execute();
      } else {
        await db
          .delete(platformLinks)
          .where(and(eq(platformLinks.guildId, guildId), eq(platformLinks.userId, userId)))
          .execute();
      }
    },

    async listPlatformLinks(guildId, platform) {
      if (platform) {
        const rows = await db
          .select()
          .from(platformLinks)
          .where(and(eq(platformLinks.guildId, guildId), eq(platformLinks.platform, platform)));
        return rows.map(rowToLink);
      }
      const rows = await db.select().from(platformLinks).where(eq(platformLinks.guildId, guildId));
      return rows.map(rowToLink);
    },
  };

  return store;
}
