import type { PostgresDatabaseCapability } from "./postgres-capability";
import { executePostgresCommands } from "./postgres-statements";
import type { TicketTranscriptCapabilityAccess } from "../contracts";

export function createPostgresTicketTranscriptCapabilityStore(
  database: PostgresDatabaseCapability,
): TicketTranscriptCapabilityAccess {
  const store: TicketTranscriptCapabilityAccess = {
    async issue(input): Promise<void> {
      await executePostgresCommands(database, [
        {
          statement: `UPDATE ticket_transcript_capabilities
             SET revoked_at_ms = COALESCE(revoked_at_ms, $1), discarded_at_ms = $2,
                 retention_expires_at_ms = LEAST(retention_expires_at_ms, $3)
             WHERE guild_id = $4 AND channel_id = $5 AND discarded_at_ms IS NULL`,
          values: [
            input.createdAtMs,
            input.createdAtMs,
            input.createdAtMs,
            input.guildId,
            input.channelId,
          ],
        },
        {
          statement: `INSERT INTO ticket_transcript_capabilities
             (object_id, guild_id, channel_id, access_token_hash, created_at_ms,
               expires_at_ms, revoked_at_ms, discarded_at_ms, retention_expires_at_ms,
               last_accessed_at_ms, access_count)
           VALUES ($1, $2, $3, $4, $5, $6, NULL, NULL, $7, NULL, 0)`,
          values: [
            input.objectId,
            input.guildId,
            input.channelId,
            await hashAccessToken(input.accessToken),
            input.createdAtMs,
            input.expiresAtMs,
            input.retentionExpiresAtMs,
          ],
        },
      ]);
    },

    async authorize(input): Promise<{ objectId: string } | null> {
      const row = await database
        .query<{ objectId: string }>(
          `SELECT object_id AS "objectId"
           FROM ticket_transcript_capabilities
           WHERE guild_id = $1 AND channel_id = $2 AND access_token_hash = $3
              AND revoked_at_ms IS NULL AND discarded_at_ms IS NULL AND expires_at_ms > $4
             AND retention_expires_at_ms > $5`,
          [
            input.guildId,
            input.channelId,
            await hashAccessToken(input.accessToken),
            input.nowMs,
            input.nowMs,
          ],
        )
        .then((rows) => rows[0] ?? null);
      if (!row) return null;

      await database.queryResult(
        `UPDATE ticket_transcript_capabilities
           SET last_accessed_at_ms = GREATEST(COALESCE(last_accessed_at_ms, 0), $1),
               access_count = access_count + 1
           WHERE object_id = $2`,
        [input.nowMs, row.objectId],
      );
      return row;
    },

    async revoke(input): Promise<boolean> {
      const result = await database.queryResult(
        `UPDATE ticket_transcript_capabilities
           SET revoked_at_ms = $1
           WHERE guild_id = $2 AND channel_id = $3
             AND revoked_at_ms IS NULL AND discarded_at_ms IS NULL`,
        [input.revokedAtMs, input.guildId, input.channelId],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async rotate(input): Promise<{ expiresAtMs: number } | null> {
      const result = await database.queryResult(
        `UPDATE ticket_transcript_capabilities
           SET access_token_hash = $1, expires_at_ms = LEAST($2, retention_expires_at_ms),
               revoked_at_ms = NULL
           WHERE guild_id = $3 AND channel_id = $4 AND discarded_at_ms IS NULL
             AND retention_expires_at_ms > $5`,
        [
          await hashAccessToken(input.accessToken),
          input.expiresAtMs,
          input.guildId,
          input.channelId,
          input.rotatedAtMs,
        ],
      );
      if ((result.rowCount ?? 0) === 0) return null;
      return database
        .query<{ expiresAtMs: number }>(
          `SELECT expires_at_ms AS "expiresAtMs"
           FROM ticket_transcript_capabilities
           WHERE guild_id = $1 AND channel_id = $2 AND discarded_at_ms IS NULL`,
          [input.guildId, input.channelId],
        )
        .then((rows) => rows[0] ?? null);
    },

    async discard(input): Promise<boolean> {
      const result = await database.queryResult(
        `UPDATE ticket_transcript_capabilities
           SET revoked_at_ms = COALESCE(revoked_at_ms, $1), discarded_at_ms = $2,
               retention_expires_at_ms = LEAST(retention_expires_at_ms, $3)
           WHERE object_id = $4 AND guild_id = $5 AND channel_id = $6
             AND discarded_at_ms IS NULL`,
        [
          input.discardedAtMs,
          input.discardedAtMs,
          input.discardedAtMs,
          input.objectId,
          input.guildId,
          input.channelId,
        ],
      );
      return (result.rowCount ?? 0) > 0;
    },

    async listRetentionExpired(nowMs, limit) {
      return database
        .queryResult<{ objectId: string; guildId: string; channelId: string }>(
          `SELECT object_id AS "objectId", guild_id AS "guildId", channel_id AS "channelId"
           FROM ticket_transcript_capabilities
           WHERE retention_expires_at_ms <= $1
           ORDER BY retention_expires_at_ms ASC
           LIMIT $2`,
          [nowMs, limit],
        )
        .then((result) => result.rows);
    },

    async deleteRetentionExpired(input): Promise<boolean> {
      const result = await database.queryResult(
        `DELETE FROM ticket_transcript_capabilities
           WHERE object_id = $1 AND retention_expires_at_ms <= $2`,
        [input.objectId, input.nowMs],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
  return store;
}

async function hashAccessToken(accessToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
