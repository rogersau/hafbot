import type { TicketTranscriptCapabilityAccess } from "./contracts";

const storeCache = new WeakMap<D1Database, TicketTranscriptCapabilityAccess>();

export function createCloudflareTicketTranscriptCapabilityStore(
  database: D1Database,
): TicketTranscriptCapabilityAccess {
  const cached = storeCache.get(database);
  if (cached) return cached;

  const store: TicketTranscriptCapabilityAccess = {
    async issue(input): Promise<void> {
      await database.batch([
        database
          .prepare(
            `UPDATE ticket_transcript_capabilities
             SET revoked_at_ms = COALESCE(revoked_at_ms, ?), discarded_at_ms = ?,
                 retention_expires_at_ms = MIN(retention_expires_at_ms, ?)
             WHERE guild_id = ? AND channel_id = ? AND discarded_at_ms IS NULL`,
          )
          .bind(
            input.createdAtMs,
            input.createdAtMs,
            input.createdAtMs,
            input.guildId,
            input.channelId,
          ),
        database
          .prepare(
            `INSERT INTO ticket_transcript_capabilities
             (object_id, guild_id, channel_id, access_token_hash, created_at_ms,
               expires_at_ms, revoked_at_ms, discarded_at_ms, retention_expires_at_ms,
               last_accessed_at_ms, access_count)
           VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, 0)`,
          )
          .bind(
            input.objectId,
            input.guildId,
            input.channelId,
            await hashAccessToken(input.accessToken),
            input.createdAtMs,
            input.expiresAtMs,
            input.retentionExpiresAtMs,
          ),
      ]);
    },

    async authorize(input): Promise<{ objectId: string } | null> {
      const row = await database
        .prepare(
          `SELECT object_id AS "objectId"
           FROM ticket_transcript_capabilities
           WHERE guild_id = ? AND channel_id = ? AND access_token_hash = ?
              AND revoked_at_ms IS NULL AND discarded_at_ms IS NULL AND expires_at_ms > ?
             AND retention_expires_at_ms > ?`,
        )
        .bind(
          input.guildId,
          input.channelId,
          await hashAccessToken(input.accessToken),
          input.nowMs,
          input.nowMs,
        )
        .first<{ objectId: string }>();
      if (!row) return null;

      await database
        .prepare(
          `UPDATE ticket_transcript_capabilities
           SET last_accessed_at_ms = MAX(COALESCE(last_accessed_at_ms, 0), ?),
               access_count = access_count + 1
           WHERE object_id = ?`,
        )
        .bind(input.nowMs, row.objectId)
        .run();
      return row;
    },

    async revoke(input): Promise<boolean> {
      const result = await database
        .prepare(
          `UPDATE ticket_transcript_capabilities
           SET revoked_at_ms = ?
           WHERE guild_id = ? AND channel_id = ?
             AND revoked_at_ms IS NULL AND discarded_at_ms IS NULL`,
        )
        .bind(input.revokedAtMs, input.guildId, input.channelId)
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async rotate(input): Promise<{ expiresAtMs: number } | null> {
      const result = await database
        .prepare(
          `UPDATE ticket_transcript_capabilities
           SET access_token_hash = ?, expires_at_ms = MIN(?, retention_expires_at_ms),
               revoked_at_ms = NULL
           WHERE guild_id = ? AND channel_id = ? AND discarded_at_ms IS NULL
             AND retention_expires_at_ms > ?`,
        )
        .bind(
          await hashAccessToken(input.accessToken),
          input.expiresAtMs,
          input.guildId,
          input.channelId,
          input.rotatedAtMs,
        )
        .run();
      if ((result.meta.changes ?? 0) === 0) return null;
      return database
        .prepare(
          `SELECT expires_at_ms AS "expiresAtMs"
           FROM ticket_transcript_capabilities
           WHERE guild_id = ? AND channel_id = ? AND discarded_at_ms IS NULL`,
        )
        .bind(input.guildId, input.channelId)
        .first<{ expiresAtMs: number }>();
    },

    async discard(input): Promise<boolean> {
      const result = await database
        .prepare(
          `UPDATE ticket_transcript_capabilities
           SET revoked_at_ms = COALESCE(revoked_at_ms, ?), discarded_at_ms = ?,
               retention_expires_at_ms = MIN(retention_expires_at_ms, ?)
           WHERE object_id = ? AND guild_id = ? AND channel_id = ?
             AND discarded_at_ms IS NULL`,
        )
        .bind(
          input.discardedAtMs,
          input.discardedAtMs,
          input.discardedAtMs,
          input.objectId,
          input.guildId,
          input.channelId,
        )
        .run();
      return (result.meta.changes ?? 0) > 0;
    },

    async listRetentionExpired(nowMs, limit) {
      return database
        .prepare(
          `SELECT object_id AS "objectId", guild_id AS "guildId", channel_id AS "channelId"
           FROM ticket_transcript_capabilities
           WHERE retention_expires_at_ms <= ?
           ORDER BY retention_expires_at_ms ASC
           LIMIT ?`,
        )
        .bind(nowMs, limit)
        .all<{ objectId: string; guildId: string; channelId: string }>()
        .then((result) => result.results);
    },

    async deleteRetentionExpired(input): Promise<boolean> {
      const result = await database
        .prepare(
          `DELETE FROM ticket_transcript_capabilities
           WHERE object_id = ? AND retention_expires_at_ms <= ?`,
        )
        .bind(input.objectId, input.nowMs)
        .run();
      return (result.meta.changes ?? 0) > 0;
    },
  };
  storeCache.set(database, store);
  return store;
}

async function hashAccessToken(accessToken: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
