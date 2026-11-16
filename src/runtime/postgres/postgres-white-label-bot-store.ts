import type { PostgresDatabaseCapability } from "./postgres-capability";
import { eq } from "drizzle-orm";
import { whiteLabelBots } from "../../db/postgres/app-schema";
import type { WhiteLabelBot, WhiteLabelBotStatus } from "../../types";
import type { WhiteLabelBotStore } from "../contracts";

type WhiteLabelBotRow = typeof whiteLabelBots.$inferSelect;
type WhiteLabelBotInsert = typeof whiteLabelBots.$inferInsert;

export function createPostgresWhiteLabelBotStore(
  database: PostgresDatabaseCapability,
): WhiteLabelBotStore {
  const db = database.drizzle;
  const store: WhiteLabelBotStore = {
    async readWhiteLabelBot(guildId: string): Promise<WhiteLabelBot | null> {
      const rows = await db
        .select()
        .from(whiteLabelBots)
        .where(eq(whiteLabelBots.guildId, guildId))
        .execute();

      return selectCurrentWhiteLabelBot(rows.map(rowToWhiteLabelBot));
    },

    async listActiveWhiteLabelBots(): Promise<WhiteLabelBot[]> {
      const result = await database.queryResult<WhiteLabelBotRow>(
        `SELECT w.guild_id AS "guildId", w.application_id AS "applicationId",
             w.bot_user_id AS "botUserId", w.display_name AS "displayName",
             w.brand_footer_text AS "brandFooterText", w.status,
             w.token_secret_ref AS "tokenSecretRef", w.created_at_ms AS "createdAtMs",
             w.updated_at_ms AS "updatedAtMs"
           FROM white_label_bots w
           JOIN billing_guild_assignments a ON a.guild_id = w.guild_id
           JOIN billing_subscriptions s ON s.owner_id = a.owner_id
           WHERE w.status = 'active' AND s.plan = 'premium_plus' AND s.status = 'active'
             AND s.quarantine_reason IS NULL`,
        [],
      );
      return result.rows.map(rowToWhiteLabelBot);
    },

    async upsertWhiteLabelBot(record: WhiteLabelBot): Promise<void> {
      const values = whiteLabelBotToRow(record);
      await db
        .insert(whiteLabelBots)
        .values(values)
        .onConflictDoUpdate({
          target: [whiteLabelBots.guildId, whiteLabelBots.botUserId],
          set: {
            applicationId: values.applicationId,
            displayName: values.displayName,
            brandFooterText: values.brandFooterText,
            status: values.status,
            tokenSecretRef: values.tokenSecretRef,
            updatedAtMs: values.updatedAtMs,
          },
        })
        .execute();
    },
  };

  return store;
}

function selectCurrentWhiteLabelBot(records: WhiteLabelBot[]): WhiteLabelBot | null {
  if (records.length === 0) return null;
  const current = records
    .filter((record) => record.status !== "decommissioned")
    .sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  return current ?? records.sort((left, right) => right.updatedAtMs - left.updatedAtMs)[0] ?? null;
}

function rowToWhiteLabelBot(row: WhiteLabelBotRow): WhiteLabelBot {
  const status = row.status;
  if (!isWhiteLabelBotStatus(status)) {
    throw new Error(`Invalid White-Label Bot status in storage: ${status}`);
  }

  return {
    guildId: row.guildId,
    applicationId: row.applicationId,
    botUserId: row.botUserId,
    displayName: row.displayName,
    brandFooterText: row.brandFooterText,
    status,
    tokenSecretRef: row.tokenSecretRef,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function whiteLabelBotToRow(record: WhiteLabelBot): WhiteLabelBotInsert {
  return {
    guildId: record.guildId,
    applicationId: record.applicationId,
    botUserId: record.botUserId,
    displayName: record.displayName,
    brandFooterText: record.brandFooterText,
    status: record.status,
    tokenSecretRef: record.tokenSecretRef,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
  };
}

function isWhiteLabelBotStatus(value: unknown): value is WhiteLabelBotStatus {
  return (
    value === "pending_install" ||
    value === "active" ||
    value === "suspended" ||
    value === "decommissioning" ||
    value === "decommissioned"
  );
}
