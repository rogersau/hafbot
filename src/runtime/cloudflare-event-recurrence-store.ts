import {
  EVENT_RECURRENCE_DAY_MS,
  eventRecurrenceFrequencySchema,
  type EventRecurrenceRecord,
} from "../event-recurrence";
import type { EventRecord } from "../types";
import type {
  EventRecurrenceLease,
  EventRecurrenceStore,
} from "./contracts/event-recurrence-store";

interface SeriesRow {
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
}

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

export function createCloudflareEventRecurrenceStore(database: D1Database): EventRecurrenceStore {
  async function read(guildId: string, seriesId: string) {
    const row = await database
      .prepare("SELECT * FROM event_recurrence_series WHERE guild_id = ? AND series_id = ?")
      .bind(guildId, seriesId)
      .first<SeriesRow>();
    return row ? readSeries(row) : null;
  }
  const fence =
    "guild_id = ? AND series_id = ? AND status = 'active' AND lease_token = ? AND lease_until_ms > ?";
  const leaseValues = (record: EventRecurrenceRecord, lease: EventRecurrenceLease) => [
    record.guildId,
    record.id,
    lease.token,
    lease.nowMs,
  ];
  return {
    read,
    async listByGuild(guildId) {
      const rows = await database
        .prepare(
          "SELECT * FROM event_recurrence_series WHERE guild_id = ? ORDER BY created_at_ms DESC, series_id",
        )
        .bind(guildId)
        .all<SeriesRow>();
      return rows.results.map(readSeries);
    },
    async readForEvent(guildId, eventId) {
      const row = await database
        .prepare(`SELECT * FROM event_recurrence_series WHERE guild_id = ? AND
        (source_event_id = ? OR pending_event_id = ? OR series_id IN (SELECT recurrence_series_id FROM events WHERE guild_id = ? AND event_id = ?)) LIMIT 1`)
        .bind(guildId, eventId, eventId, guildId, eventId)
        .first<SeriesRow>();
      return row ? readSeries(row) : null;
    },
    async create(record) {
      await database.batch([
        database
          .prepare(`INSERT INTO event_recurrence_series
          (guild_id,series_id,source_event_id,snapshot_json,frequency,until_at_ms,next_starts_at_ms,next_publishes_at_ms,status,last_event_id,created_by_user_id,created_at_ms,updated_at_ms)
          VALUES (?,?,?,?,?,?,?,?,'active',?,?,?,?) ON CONFLICT(guild_id,source_event_id) DO NOTHING`)
          .bind(
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
          ),
        database
          .prepare(`UPDATE events SET recurrence_series_id = (SELECT series_id FROM event_recurrence_series WHERE guild_id = ? AND source_event_id = ?)
          WHERE guild_id = ? AND event_id = ? AND recurrence_series_id IS NULL`)
          .bind(record.guildId, record.sourceEventId, record.guildId, record.sourceEventId),
      ]);
      const row = await database
        .prepare("SELECT * FROM event_recurrence_series WHERE guild_id = ? AND source_event_id = ?")
        .bind(record.guildId, record.sourceEventId)
        .first<SeriesRow>();
      if (!row) throw new Error("Event recurrence could not be saved.");
      return readSeries(row);
    },
    async listDue(nowMs, limit) {
      const rows = await database
        .prepare(`SELECT * FROM event_recurrence_series WHERE status = 'active' AND lease_until_ms <= ? AND next_publishes_at_ms <= ?
        ORDER BY next_starts_at_ms, series_id LIMIT ?`)
        .bind(nowMs, nowMs, Math.min(50, Math.max(1, limit)))
        .all<SeriesRow>();
      return rows.results.map(readSeries);
    },
    async claim(record, lease) {
      const row = await database
        .prepare(`UPDATE event_recurrence_series SET lease_token = ?, lease_until_ms = ?
        WHERE guild_id = ? AND series_id = ? AND status = 'active' AND next_starts_at_ms = ? AND lease_until_ms <= ? RETURNING series_id`)
        .bind(
          lease.token,
          lease.nowMs + 120_000,
          record.guildId,
          record.id,
          record.nextStartsAtMs,
          lease.nowMs,
        )
        .first();
      return row !== null;
    },
    async prepareOccurrence(record, startsAtMs, eventId, lease) {
      const row = await database
        .prepare(`UPDATE event_recurrence_series SET next_starts_at_ms = ?, pending_event_id = ?, publication_attempted_at_ms = NULL, updated_at_ms = ?, lease_until_ms = ?
        WHERE ${fence} AND pending_event_id IS NULL RETURNING series_id`)
        .bind(
          startsAtMs,
          eventId,
          lease.nowMs,
          lease.nowMs + 120_000,
          ...leaseValues(record, lease),
        )
        .first();
      return row !== null;
    },
    async linkOccurrence(guildId, seriesId, eventId, lease) {
      const row = await database
        .prepare(`UPDATE events SET recurrence_series_id = ? WHERE guild_id = ? AND event_id = ?
        AND (recurrence_series_id IS NULL OR recurrence_series_id = ?) AND EXISTS
        (SELECT 1 FROM event_recurrence_series WHERE ${fence} AND pending_event_id = ?) RETURNING event_id`)
        .bind(
          seriesId,
          guildId,
          eventId,
          seriesId,
          guildId,
          seriesId,
          lease.token,
          lease.nowMs,
          eventId,
        )
        .first();
      return row !== null;
    },
    async markPublicationAttempted(record, lease) {
      const row = await database
        .prepare(`UPDATE event_recurrence_series SET publication_attempted_at_ms = ?, updated_at_ms = ?, lease_until_ms = ?
        WHERE ${fence} AND pending_event_id = ? AND publication_attempted_at_ms IS NULL RETURNING series_id`)
        .bind(
          lease.nowMs,
          lease.nowMs,
          lease.nowMs + 120_000,
          ...leaseValues(record, lease),
          record.pendingEventId,
        )
        .first();
      return row !== null;
    },
    async finish(record, nextStartsAtMs, completed, lease) {
      const row = await database
        .prepare(`UPDATE event_recurrence_series SET status = ?, next_starts_at_ms = ?, next_publishes_at_ms = ?, last_event_id = ?,
        pending_event_id = NULL, publication_attempted_at_ms = NULL, failure_reason = NULL, updated_at_ms = ?
        WHERE ${fence} AND (pending_event_id = ? OR (pending_event_id IS NULL AND CAST(? AS TEXT) IS NULL)) RETURNING series_id`)
        .bind(
          completed ? "completed" : "active",
          nextStartsAtMs,
          nextStartsAtMs -
            (record.frequency === "daily" ? EVENT_RECURRENCE_DAY_MS : 7 * EVENT_RECURRENCE_DAY_MS) +
            (record.snapshot.endsAtMs! - record.snapshot.startsAtMs),
          record.pendingEventId ?? record.lastEventId,
          lease.nowMs,
          ...leaseValues(record, lease),
          record.pendingEventId,
          record.pendingEventId,
        )
        .first();
      return row !== null;
    },
    async fail(record, reason, lease) {
      const row = await database
        .prepare(`UPDATE event_recurrence_series SET status = 'failed', failure_reason = ?, updated_at_ms = ?
        WHERE ${fence} RETURNING series_id`)
        .bind(reason, lease.nowMs, ...leaseValues(record, lease))
        .first();
      return row !== null;
    },
    async stop(guildId, seriesId, nowMs) {
      const row = await database
        .prepare(`UPDATE event_recurrence_series SET status = 'stopped', updated_at_ms = ?
        WHERE guild_id = ? AND series_id = ? AND lease_until_ms <= ? RETURNING *`)
        .bind(nowMs, guildId, seriesId, nowMs)
        .first<SeriesRow>();
      return row ? readSeries(row) : null;
    },
    async release(guildId, seriesId, token) {
      await database
        .prepare(
          "UPDATE event_recurrence_series SET lease_token = NULL, lease_until_ms = 0 WHERE guild_id = ? AND series_id = ? AND lease_token = ?",
        )
        .bind(guildId, seriesId, token)
        .run();
    },
  };
}
