import type { PostgresDatabaseCapability } from "./postgres-capability";
import { executePostgresCommands } from "./postgres-statements";
import {
  EVENT_RECURRENCE_DAY_MS,
  eventRecurrenceFrequencySchema,
  type EventRecurrenceRecord,
} from "../../event-recurrence";
import type { EventRecord } from "../../types";
import type {
  EventRecurrenceLease,
  EventRecurrenceStore,
} from "../contracts/event-recurrence-store";

type SeriesRow = {
  guild_id: string;
  series_id: string;
  source_event_id: string;
  snapshot_json: string;
  frequency: string;
  until_at_ms: number | null;
  next_starts_at_ms: number;
  next_publishes_at_ms: number;
  status: EventRecurrenceRecord["status"];
  pending_event_id: string | null;
  publication_attempted_at_ms: number | null;
  last_event_id: string;
  failure_reason: string | null;
  created_by_user_id: string;
  created_at_ms: number;
  updated_at_ms: number;
};

function readSeries(row: SeriesRow): EventRecurrenceRecord {
  const snapshot = JSON.parse(row.snapshot_json) as EventRecord;
  return {
    guildId: row.guild_id,
    id: row.series_id,
    sourceEventId: row.source_event_id,
    title: snapshot.title,
    snapshot,
    frequency: eventRecurrenceFrequencySchema.parse(row.frequency),
    untilAtMs: row.until_at_ms === null ? null : Number(row.until_at_ms),
    nextStartsAtMs: Number(row.next_starts_at_ms),
    nextPublishesAtMs: Number(row.next_publishes_at_ms),
    status: row.status,
    pendingEventId: row.pending_event_id,
    publicationAttemptedAtMs:
      row.publication_attempted_at_ms === null ? null : Number(row.publication_attempted_at_ms),
    lastEventId: row.last_event_id,
    failureReason: row.failure_reason,
    createdByUserId: row.created_by_user_id,
    createdAtMs: Number(row.created_at_ms),
    updatedAtMs: Number(row.updated_at_ms),
  };
}

export function createPostgresEventRecurrenceStore(
  database: PostgresDatabaseCapability,
): EventRecurrenceStore {
  async function read(guildId: string, seriesId: string) {
    const row = await database
      .query<SeriesRow>(
        "SELECT * FROM event_recurrence_series WHERE guild_id = $1 AND series_id = $2",
        [guildId, seriesId],
      )
      .then((rows) => rows[0] ?? null);
    return row ? readSeries(row) : null;
  }
  const leaseValues = (record: EventRecurrenceRecord, lease: EventRecurrenceLease) => [
    record.guildId,
    record.id,
    lease.token,
    lease.nowMs,
  ];
  return {
    read,
    async listByGuild(guildId) {
      const rows = await database.queryResult<SeriesRow>(
        "SELECT * FROM event_recurrence_series WHERE guild_id = $1 ORDER BY created_at_ms DESC, series_id",
        [guildId],
      );
      return rows.rows.map(readSeries);
    },
    async readForEvent(guildId, eventId) {
      const row = await database
        .query<SeriesRow>(
          `SELECT * FROM event_recurrence_series WHERE guild_id = $1 AND
        (source_event_id = $2 OR pending_event_id = $3 OR series_id IN (SELECT recurrence_series_id FROM events WHERE guild_id = $4 AND event_id = $5)) LIMIT 1`,
          [guildId, eventId, eventId, guildId, eventId],
        )
        .then((rows) => rows[0] ?? null);
      return row ? readSeries(row) : null;
    },
    async create(record) {
      await executePostgresCommands(database, [
        {
          statement: `INSERT INTO event_recurrence_series
          (guild_id,series_id,source_event_id,snapshot_json,frequency,until_at_ms,next_starts_at_ms,next_publishes_at_ms,status,last_event_id,created_by_user_id,created_at_ms,updated_at_ms)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10,$11,$12) ON CONFLICT(guild_id,source_event_id) DO NOTHING`,
          values: [
            record.guildId,
            record.id,
            record.sourceEventId,
            JSON.stringify(record.snapshot),
            record.frequency,
            record.untilAtMs,
            record.nextStartsAtMs,
            record.nextPublishesAtMs,
            record.lastEventId,
            record.createdByUserId,
            record.createdAtMs,
            record.updatedAtMs,
          ],
        },
        {
          statement: `UPDATE events SET recurrence_series_id = (SELECT series_id FROM event_recurrence_series WHERE guild_id = $1 AND source_event_id = $2)
          WHERE guild_id = $3 AND event_id = $4 AND recurrence_series_id IS NULL`,
          values: [record.guildId, record.sourceEventId, record.guildId, record.sourceEventId],
        },
      ]);
      const row = await database
        .query<SeriesRow>(
          "SELECT * FROM event_recurrence_series WHERE guild_id = $1 AND source_event_id = $2",
          [record.guildId, record.sourceEventId],
        )
        .then((rows) => rows[0] ?? null);
      if (!row) throw new Error("Event recurrence could not be saved.");
      return readSeries(row);
    },
    async listDue(nowMs, limit) {
      const rows = await database.queryResult<SeriesRow>(
        `SELECT * FROM event_recurrence_series WHERE status = 'active' AND lease_until_ms <= $1 AND next_publishes_at_ms <= $2
        ORDER BY next_starts_at_ms, series_id LIMIT $3`,
        [nowMs, nowMs, Math.min(50, Math.max(1, limit))],
      );
      return rows.rows.map(readSeries);
    },
    async claim(record, lease) {
      const row = await database
        .query(
          `UPDATE event_recurrence_series SET lease_token = $1, lease_until_ms = $2
        WHERE guild_id = $3 AND series_id = $4 AND status = 'active' AND next_starts_at_ms = $5 AND lease_until_ms <= $6 RETURNING series_id`,
          [
            lease.token,
            lease.nowMs + 120_000,
            record.guildId,
            record.id,
            record.nextStartsAtMs,
            lease.nowMs,
          ],
        )
        .then((rows) => rows[0] ?? null);
      return row !== null;
    },
    async prepareOccurrence(record, startsAtMs, eventId, lease) {
      const row = await database
        .query(
          `UPDATE event_recurrence_series SET next_starts_at_ms = $1, pending_event_id = $2, publication_attempted_at_ms = NULL, updated_at_ms = $3, lease_until_ms = $4
        WHERE guild_id = $5 AND series_id = $6 AND status = 'active' AND lease_token = $7 AND lease_until_ms > $8 AND pending_event_id IS NULL RETURNING series_id`,
          [startsAtMs, eventId, lease.nowMs, lease.nowMs + 120_000, ...leaseValues(record, lease)],
        )
        .then((rows) => rows[0] ?? null);
      return row !== null;
    },
    async linkOccurrence(guildId, seriesId, eventId, lease) {
      const row = await database
        .query(
          `UPDATE events SET recurrence_series_id = $1 WHERE guild_id = $2 AND event_id = $3
        AND (recurrence_series_id IS NULL OR recurrence_series_id = $4) AND EXISTS
        (SELECT 1 FROM event_recurrence_series WHERE guild_id = $5 AND series_id = $6 AND status = 'active' AND lease_token = $7 AND lease_until_ms > $8 AND pending_event_id = $9) RETURNING event_id`,
          [
            seriesId,
            guildId,
            eventId,
            seriesId,
            guildId,
            seriesId,
            lease.token,
            lease.nowMs,
            eventId,
          ],
        )
        .then((rows) => rows[0] ?? null);
      return row !== null;
    },
    async markPublicationAttempted(record, lease) {
      const row = await database
        .query(
          `UPDATE event_recurrence_series SET publication_attempted_at_ms = $1, updated_at_ms = $2, lease_until_ms = $3
        WHERE guild_id = $4 AND series_id = $5 AND status = 'active' AND lease_token = $6 AND lease_until_ms > $7 AND pending_event_id = $8 AND publication_attempted_at_ms IS NULL RETURNING series_id`,
          [
            lease.nowMs,
            lease.nowMs,
            lease.nowMs + 120_000,
            ...leaseValues(record, lease),
            record.pendingEventId,
          ],
        )
        .then((rows) => rows[0] ?? null);
      return row !== null;
    },
    async finish(record, nextStartsAtMs, completed, lease) {
      const row = await database
        .query(
          `UPDATE event_recurrence_series SET status = $1, next_starts_at_ms = $2, next_publishes_at_ms = $3, last_event_id = $4,
        pending_event_id = NULL, publication_attempted_at_ms = NULL, failure_reason = NULL, updated_at_ms = $5
        WHERE guild_id = $6 AND series_id = $7 AND status = 'active' AND lease_token = $8 AND lease_until_ms > $9 AND (pending_event_id = $10 OR (pending_event_id IS NULL AND CAST($11 AS TEXT) IS NULL)) RETURNING series_id`,
          [
            completed ? "completed" : "active",
            nextStartsAtMs,
            nextStartsAtMs -
              (record.frequency === "daily"
                ? EVENT_RECURRENCE_DAY_MS
                : 7 * EVENT_RECURRENCE_DAY_MS) +
              (record.snapshot.endsAtMs! - record.snapshot.startsAtMs),
            record.pendingEventId ?? record.lastEventId,
            lease.nowMs,
            ...leaseValues(record, lease),
            record.pendingEventId,
            record.pendingEventId,
          ],
        )
        .then((rows) => rows[0] ?? null);
      return row !== null;
    },
    async fail(record, reason, lease) {
      const row = await database
        .query(
          `UPDATE event_recurrence_series SET status = 'failed', failure_reason = $1, updated_at_ms = $2
        WHERE guild_id = $3 AND series_id = $4 AND status = 'active' AND lease_token = $5 AND lease_until_ms > $6 RETURNING series_id`,
          [reason, lease.nowMs, ...leaseValues(record, lease)],
        )
        .then((rows) => rows[0] ?? null);
      return row !== null;
    },
    async stop(guildId, seriesId, nowMs) {
      const row = await database
        .query<SeriesRow>(
          `UPDATE event_recurrence_series SET status = 'stopped', updated_at_ms = $1
        WHERE guild_id = $2 AND series_id = $3 AND lease_until_ms <= $4 RETURNING *`,
          [nowMs, guildId, seriesId, nowMs],
        )
        .then((rows) => rows[0] ?? null);
      return row ? readSeries(row) : null;
    },
    async release(guildId, seriesId, token) {
      await database.queryResult(
        "UPDATE event_recurrence_series SET lease_token = NULL, lease_until_ms = 0 WHERE guild_id = $1 AND series_id = $2 AND lease_token = $3",
        [guildId, seriesId, token],
      );
    },
  };
}
