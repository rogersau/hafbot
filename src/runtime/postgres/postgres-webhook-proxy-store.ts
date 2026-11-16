import { configToRow, rowToConfig, logToRow, rowToLog } from "../webhook-proxy-records";
import { executePostgresStatements } from "./postgres-statements";
import { and, desc, eq, notInArray } from "drizzle-orm";
import { webhookProxyConfigs, webhookProxyForwardLogs } from "../../db/postgres/app-schema";
import type { WebhookProxyConfig, WebhookProxyForwardLog } from "../../types";
import type { WebhookProxyStore } from "../contracts";
import type { PostgresDatabaseCapability } from "./postgres-capability";

export function createPostgresWebhookProxyStore(
  database: PostgresDatabaseCapability,
): WebhookProxyStore {
  const db = database.drizzle;
  const store: WebhookProxyStore = {
    async readWebhookProxyConfig(publicId: string): Promise<WebhookProxyConfig | null> {
      const row = await db
        .select()
        .from(webhookProxyConfigs)
        .where(eq(webhookProxyConfigs.publicId, publicId))
        .limit(1)
        .then((rows) => rows[0]);

      return row ? rowToConfig(row) : null;
    },

    async listWebhookProxyConfigs(guildId: string): Promise<WebhookProxyConfig[]> {
      const rows = await db
        .select()
        .from(webhookProxyConfigs)
        .where(eq(webhookProxyConfigs.guildId, guildId))
        .orderBy(desc(webhookProxyConfigs.updatedAtMs))
        .execute();

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
        .execute();
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
        .execute();
    },

    async createWebhookProxyForwardLog(log: WebhookProxyForwardLog): Promise<void> {
      await executePostgresStatements(database, [
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
        .execute();

      return rows.map(rowToLog);
    },
  };

  return store;
}
