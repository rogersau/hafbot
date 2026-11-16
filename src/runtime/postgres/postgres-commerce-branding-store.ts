import type { PostgresDatabaseCapability } from "./postgres-capability";
import type {
  CommerceBranding,
  CommerceBrandingInput,
  CommerceBrandingStore,
} from "../../commerce/branding";

type Row = Record<string, unknown>;

export class PostgresCommerceBrandingStore implements CommerceBrandingStore {
  constructor(private readonly database: PostgresDatabaseCapability) {}

  async readByGuild(guildId: string): Promise<CommerceBranding | null> {
    const row = await this.database
      .query<Row>(
        `SELECT guild_id, connected_account_id, accent_color, tagline,
                created_by_user_id, updated_by_user_id, created_at_ms, updated_at_ms
           FROM commerce_store_branding
          WHERE guild_id = $1 LIMIT 1`,
        [guildId],
      )
      .then((rows) => rows[0] ?? null);
    return row ? brandingFromRow(row) : null;
  }

  async save(input: CommerceBrandingInput): Promise<CommerceBranding> {
    await this.database.queryResult(
      `INSERT INTO commerce_store_branding
          (guild_id, connected_account_id, accent_color, tagline,
           created_by_user_id, updated_by_user_id, created_at_ms, updated_at_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT(guild_id) DO UPDATE SET
           connected_account_id = excluded.connected_account_id,
           accent_color = excluded.accent_color,
           tagline = excluded.tagline,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_at_ms = excluded.updated_at_ms`,
      [
        input.guildId,
        input.connectedAccountId,
        input.accentColor,
        input.tagline,
        input.actorUserId,
        input.actorUserId,
        input.nowMs,
        input.nowMs,
      ],
    );
    const saved = await this.readByGuild(input.guildId);
    if (!saved) throw new Error("commerce_branding_persistence_failed");
    return saved;
  }

  async reset(guildId: string, connectedAccountId: string): Promise<void> {
    await this.database.queryResult(
      `DELETE FROM commerce_store_branding
          WHERE guild_id = $1 AND connected_account_id = $2`,
      [guildId, connectedAccountId],
    );
  }
}

function brandingFromRow(row: Row): CommerceBranding {
  return {
    guildId: String(row.guild_id),
    connectedAccountId: String(row.connected_account_id),
    accentColor: Number(row.accent_color),
    tagline: String(row.tagline),
    createdByUserId: String(row.created_by_user_id),
    updatedByUserId: String(row.updated_by_user_id),
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}
