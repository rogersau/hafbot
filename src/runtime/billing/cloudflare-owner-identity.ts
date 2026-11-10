import type { BillingAuditIdentity } from "./types";

export async function resolveBillingOwnerIdentity(
  database: D1Database,
  ownerId: string,
): Promise<BillingAuditIdentity | null> {
  const row = await database
    .prepare(
      'SELECT "discordUserId" AS discord_user_id, "name" AS display_name FROM "User" WHERE id = ?',
    )
    .bind(ownerId)
    .first<{ discord_user_id: string; display_name: string }>();
  return row ? { discordUserId: row.discord_user_id, displayName: row.display_name } : null;
}
