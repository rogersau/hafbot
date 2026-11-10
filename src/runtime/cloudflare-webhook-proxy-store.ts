import { and, desc, eq, notInArray } from "drizzle-orm";
import { webhookProxyConfigs, webhookProxyForwardLogs } from "../db/app-schema";
import type { WebhookProxyConfig, WebhookProxyForwardLog } from "../types";
import type { WebhookProxyStore } from "./contracts";
import { createD1DrizzleDatabase } from "./drizzle-db";

type WebhookProxyConfigRow = typeof webhookProxyConfigs.$inferSelect;
type WebhookProxyConfigInsert = typeof webhookProxyConfigs.$inferInsert;
type WebhookProxyForwardLogRow = typeof webhookProxyForwardLogs.$inferSelect;
type WebhookProxyForwardLogInsert = typeof webhookProxyForwardLogs.$inferInsert;

const webhookProxyStoreCache = new WeakMap<D1Database, WebhookProxyStore>();

export function createCloudflareWebhookProxyStore(database: D1Database): WebhookProxyStore {
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
            banLookupNotificationUrl: values.banLookupNotificationUrl,
            banLookupAppIdsJson: values.banLookupAppIdsJson,
            destinationsV2Json: values.destinationsV2Json,
            banLookupCredentialId: values.banLookupCredentialId,
            credentialMigratedAtMs: values.credentialMigratedAtMs,
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

function rowToConfig(row: WebhookProxyConfigRow): WebhookProxyConfig {
  return {
    guildId: row.guildId,
    publicId: row.publicId,
    name: row.name,
    enabled: row.enabled === 1,
    destinations: JSON.parse(row.destinationsJson) as WebhookProxyConfig["destinations"],
    defaultDestinationIds: JSON.parse(
      row.defaultDestinationIdsJson,
    ) as WebhookProxyConfig["defaultDestinationIds"],
    routingRules: JSON.parse(row.routingRulesJson) as WebhookProxyConfig["routingRules"],
    contentReplacements: JSON.parse(row.contentReplacementsJson ?? "[]") as NonNullable<
      WebhookProxyConfig["contentReplacements"]
    >,
    banLookupEnabled: row.banLookupEnabled === 1,
    banLookupNotificationUrl: row.banLookupNotificationUrl,
    banLookupAppIds: JSON.parse(row.banLookupAppIdsJson ?? "[]") as number[],
    ...(row.destinationsV2Json
      ? {
          destinationsV2: JSON.parse(row.destinationsV2Json) as NonNullable<
            WebhookProxyConfig["destinationsV2"]
          >,
        }
      : {}),
    ...(row.banLookupCredentialId ? { banLookupCredentialId: row.banLookupCredentialId } : {}),
    ...(row.credentialMigratedAtMs !== null
      ? { credentialMigratedAtMs: row.credentialMigratedAtMs }
      : {}),
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function configToRow(config: WebhookProxyConfig): WebhookProxyConfigInsert {
  return {
    guildId: config.guildId,
    publicId: config.publicId,
    name: config.name,
    enabled: config.enabled ? 1 : 0,
    destinationsJson: JSON.stringify(config.destinations),
    defaultDestinationIdsJson: JSON.stringify(config.defaultDestinationIds),
    routingRulesJson: JSON.stringify(config.routingRules),
    contentReplacementsJson: JSON.stringify(config.contentReplacements ?? []),
    banLookupEnabled: config.banLookupEnabled ? 1 : 0,
    banLookupNotificationUrl: config.banLookupNotificationUrl ?? null,
    banLookupAppIdsJson: JSON.stringify(config.banLookupAppIds ?? []),
    destinationsV2Json: config.destinationsV2 ? JSON.stringify(config.destinationsV2) : null,
    banLookupCredentialId: config.banLookupCredentialId ?? null,
    credentialMigratedAtMs: config.credentialMigratedAtMs ?? null,
    createdAtMs: config.createdAtMs,
    updatedAtMs: config.updatedAtMs,
  };
}

function rowToLog(row: WebhookProxyForwardLogRow): WebhookProxyForwardLog {
  return {
    guildId: row.guildId,
    id: row.logId,
    publicId: row.publicId,
    destinationId: row.destinationId,
    destinationUrl: row.destinationUrl || undefined,
    ...(row.credentialFingerprint ? { credentialFingerprint: row.credentialFingerprint } : {}),
    status: row.status,
    ok: row.ok === 1,
    attempt: row.attempt,
    error: row.error,
    timestampMs: row.timestampMs,
  };
}

function logToRow(log: WebhookProxyForwardLog): WebhookProxyForwardLogInsert {
  return {
    guildId: log.guildId,
    logId: log.id,
    publicId: log.publicId,
    destinationId: log.destinationId,
    destinationUrl: log.destinationUrl ?? "",
    credentialFingerprint: log.credentialFingerprint ?? null,
    status: log.status,
    ok: log.ok ? 1 : 0,
    attempt: log.attempt,
    error: log.error,
    timestampMs: log.timestampMs,
  };
}
