import type { PostgresDatabaseCapability } from "./postgres-capability";
import type { BillingAuditIdentity } from "../billing/types";

export async function resolveBillingOwnerIdentity(
  database: PostgresDatabaseCapability,
  ownerId: string,
): Promise<BillingAuditIdentity | null> {
  const row = await database
    .query<{ discord_user_id: string; display_name: string }>(
      'SELECT "discordUserId" AS discord_user_id, "name" AS display_name FROM "User" WHERE id = $1',
      [ownerId],
    )
    .then((rows) => rows[0] ?? null);
  return row ? { discordUserId: row.discord_user_id, displayName: row.display_name } : null;
}
