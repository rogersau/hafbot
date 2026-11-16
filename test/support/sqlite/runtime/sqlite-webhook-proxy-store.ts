import {
  configToRow,
  rowToConfig,
  logToRow,
  rowToLog,
} from "../../../../src/runtime/webhook-proxy-records";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { webhookProxyConfigs, webhookProxyForwardLogs } from "../db/app-schema";
import type { WebhookProxyConfig, WebhookProxyForwardLog } from "../../../../src/types";
import type { WebhookProxyStore } from "../../../../src/runtime/contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";

const webhookProxyStoreCache = new WeakMap<D1Database, WebhookProxyStore>();

export function createSqliteWebhookProxyStore(database: D1Database): WebhookProxyStore {
  const cached = webhookProxyStoreCache.get(database);
  if (cached) {
    return cached;
  }

  const db = createD1DrizzleDatabase(database);
  const store: WebhookProxyStore = {
    async readWebhookProxyConfig(publicId: string): Promise<WebhookProxyConfig | null> {
      const row = await db
        .select()
        .from(webhookProxyConfigs)
        .where(eq(webhookProxyConfigs.publicId, publicId))
        .limit(1)
        .get();

      return row ? rowToConfig(row) : null;
    },

    async listWebhookProxyConfigs(guildId: string): Promise<WebhookProxyConfig[]> {
      const rows = await db
        .select()
        .from(webhookProxyConfigs)
        .where(eq(webhookProxyConfigs.guildId, guildId))
        .orderBy(desc(webhookProxyConfigs.updatedAtMs))
        .all();

      return rows.map(rowToConfig);
    },

    async upsertWebhookProxyConfig(config: WebhookProxyConfig): Promise<void> {
      const values = configToRow(config);
      await db
        .insert(webhookProxyConfigs)
        .values(values)
        .onConflictDoUpdate({
          target: [webhookProxyConfigs.guildId, webhookProxyConfigs.publicId],
          set: {
            name: values.name,
            enabled: values.enabled,
            destinationsJson: values.destinationsJson,
            defaultDestinationIdsJson: values.defaultDestinationIdsJson,
            routingRulesJson: values.routingRulesJson,
            contentReplacementsJson: values.contentReplacementsJson,
            banLookupEnabled: values.banLookupEnabled,
            banLookupAppIdsJson: values.banLookupAppIdsJson,
            banLookupCredentialId: values.banLookupCredentialId,
            updatedAtMs: values.updatedAtMs,
          },
        })
        .run();
    },

    async deleteWebhookProxyConfig(body: { guildId: string; publicId: string }): Promise<void> {
      await db
        .delete(webhookProxyConfigs)
        .where(
          and(
            eq(webhookProxyConfigs.guildId, body.guildId),
            eq(webhookProxyConfigs.publicId, body.publicId),
          ),
        )
        .run();
    },

    async createWebhookProxyForwardLog(log: WebhookProxyForwardLog): Promise<void> {
      await db.batch([
        db.insert(webhookProxyForwardLogs).values(logToRow(log)),
        db
          .delete(webhookProxyForwardLogs)
          .where(
            and(
              eq(webhookProxyForwardLogs.guildId, log.guildId),
              notInArray(
                webhookProxyForwardLogs.logId,
                db
                  .select({ logId: webhookProxyForwardLogs.logId })
                  .from(webhookProxyForwardLogs)
                  .where(eq(webhookProxyForwardLogs.guildId, log.guildId))
                  .orderBy(desc(webhookProxyForwardLogs.timestampMs))
                  .limit(1000),
              ),
            ),
          ),
      ]);
    },

    async listWebhookProxyForwardLogs(
      guildId: string,
      publicId: string,
      limit = 20,
    ): Promise<WebhookProxyForwardLog[]> {
      const rows = await db
        .select()
        .from(webhookProxyForwardLogs)
        .where(
          and(
            eq(webhookProxyForwardLogs.guildId, guildId),
            eq(webhookProxyForwardLogs.publicId, publicId),
          ),
        )
        .orderBy(desc(webhookProxyForwardLogs.timestampMs))
        .limit(Math.min(Math.max(limit, 1), 100))
        .all();

      return rows.map(rowToLog);
    },
  };

  webhookProxyStoreCache.set(database, store);
  return store;
}
