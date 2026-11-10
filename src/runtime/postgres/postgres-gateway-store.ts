import { shouldHandleDispatch } from "../../gateway";
import { isRecord } from "../../unknown-parse";
import type { GatewayEventEnvelope } from "../gateway-events/contracts";
import { deriveGatewayEventKey } from "../gateway-event-idempotency";
import type { GatewaySnapshot } from "../contracts";
import type { PostgresLease } from "./postgres-lease-store";
import type { PostgresDatabaseCapability, PostgresExecutor } from "./postgres-capability";
import type { PostgresJobQueue } from "./postgres-job-queue";
import { readPostgresSafeInteger } from "./postgres-values";

export interface PostgresGatewaySnapshot extends GatewaySnapshot {
  lastHeartbeatAtMs: number | null;
  lastHeartbeatAckAtMs: number | null;
  fencingGeneration: number;
  updatedAtMs: number;
}

export interface PostgresGatewayStateStore {
  read(identityId: string): Promise<PostgresGatewaySnapshot | null>;
  // Metadata writes never change resumable progress, including on initial insert.
  write(
    identityId: string,
    lease: PostgresLease,
    snapshot: GatewaySnapshot,
    input?: {
      nowMs?: number;
      lastHeartbeatAtMs?: number | null;
      lastHeartbeatAckAtMs?: number | null;
    },
  ): Promise<boolean>;
  clearResumeState(identityId: string, lease: PostgresLease, nowMs?: number): Promise<void>;
  // Acceptance owns committed progress. A null envelope is a successful unhandled dispatch.
  dispatch(input: {
    identityId: string;
    botUserId: string;
    lease: PostgresLease;
    sessionId: string | null;
    sequence: number | null;
    ready?: { sessionId: string; resumeGatewayUrl: string };
    type: string;
    data: unknown;
    nowMs?: number;
  }): Promise<GatewayEventEnvelope | null>;
  cleanupMessageAuditContext(input?: {
    nowMs?: number;
    retentionMs?: number;
    maxRowsPerIdentity?: number;
    batchSize?: number;
  }): Promise<number>;
}

const MESSAGE_AUDIT_CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MESSAGE_AUDIT_CONTEXT_MAX_ROWS = 100_000;

export class GatewayLeaseLostError extends Error {
  constructor(identityId: string) {
    super(`PostgreSQL Gateway lease was lost for ${identityId}.`);
    this.name = "GatewayLeaseLostError";
  }
}

export function createPostgresGatewayStateStore(
  database: PostgresDatabaseCapability,
  jobs: PostgresJobQueue,
): PostgresGatewayStateStore {
  return {
    async read(identityId) {
      assertIdentifier(identityId, "identityId");
      const rows = await database.query<GatewaySessionRow>(
        "SELECT * FROM gateway_sessions WHERE identity_id = $1",
        [identityId],
      );
      return rows[0] ? mapSnapshot(rows[0]) : null;
    },

    async write(identityId, lease, snapshot, input = {}) {
      assertIdentifier(identityId, "identityId");
      assertLeaseMatches(identityId, lease);
      const now = new Date(input.nowMs ?? Date.now());
      const heartbeatAt = readOptionalDate(input.lastHeartbeatAtMs);
      const heartbeatAckAt = readOptionalDate(input.lastHeartbeatAckAtMs);
      try {
        return await database.transaction(async (transaction) => {
          await requireLease(transaction, lease, now);
          await transaction.execute(
            `INSERT INTO gateway_sessions (
               identity_id, status, backoff_attempt, last_error, heartbeat_interval_ms,
               last_heartbeat_at, last_heartbeat_ack_at, fencing_generation, updated_at
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (identity_id) DO UPDATE SET
               status = EXCLUDED.status,
               backoff_attempt = EXCLUDED.backoff_attempt,
               last_error = EXCLUDED.last_error,
               heartbeat_interval_ms = EXCLUDED.heartbeat_interval_ms,
               last_heartbeat_at = COALESCE(EXCLUDED.last_heartbeat_at, gateway_sessions.last_heartbeat_at),
               last_heartbeat_ack_at = COALESCE(EXCLUDED.last_heartbeat_ack_at, gateway_sessions.last_heartbeat_ack_at),
               fencing_generation = EXCLUDED.fencing_generation,
               updated_at = EXCLUDED.updated_at`,
            [
              identityId,
              snapshot.status,
              snapshot.backoffAttempt,
              snapshot.lastError,
              snapshot.heartbeatIntervalMs,
              heartbeatAt,
              heartbeatAckAt,
              lease.fencingGeneration,
              now,
            ],
          );
          return true;
        });
      } catch (error) {
        if (error instanceof GatewayLeaseLostError) return false;
        throw error;
      }
    },

    async clearResumeState(identityId, lease, nowMs = Date.now()) {
      assertIdentifier(identityId, "identityId");
      assertLeaseMatches(identityId, lease);
      const now = new Date(nowMs);
      await database.transaction(async (transaction) => {
        await requireLease(transaction, lease, now);
        const updated = await transaction.execute(
          `UPDATE gateway_sessions
              SET session_id = NULL, resume_gateway_url = NULL, last_sequence = NULL,
                  fencing_generation = $1, updated_at = $2
            WHERE identity_id = $3`,
          [lease.fencingGeneration, now, identityId],
        );
        if (updated !== 1) throw new GatewayLeaseLostError(identityId);
      });
    },

    async dispatch(input) {
      assertIdentifier(input.identityId, "identityId");
      assertIdentifier(input.botUserId, "botUserId");
      assertLeaseMatches(input.identityId, input.lease);
      const ready = input.type === "READY" ? input.ready : undefined;
      if (input.type === "READY") {
        if (!ready || input.sequence === null || !Number.isSafeInteger(input.sequence)) {
          throw new Error("READY requires a validated resume session and sequence.");
        }
        assertIdentifier(ready.sessionId, "sessionId");
        assertIdentifier(ready.resumeGatewayUrl, "resumeGatewayUrl");
      }
      const now = new Date(input.nowMs ?? Date.now());
      return database.transaction(async (transaction) => {
        await requireLease(transaction, input.lease, now);
        const updated = ready
          ? await transaction.execute(
              `UPDATE gateway_sessions
                    SET session_id = $1, resume_gateway_url = $2, last_sequence = $3,
                        fencing_generation = $4, updated_at = $5
                  WHERE identity_id = $6`,
              [
                ready.sessionId,
                ready.resumeGatewayUrl,
                input.sequence,
                input.lease.fencingGeneration,
                now,
                input.identityId,
              ],
            )
          : await transaction.execute(
              `UPDATE gateway_sessions
                    SET last_sequence = $1, fencing_generation = $2, updated_at = $3
                  WHERE identity_id = $4`,
              [input.sequence, input.lease.fencingGeneration, now, input.identityId],
            );
        if (updated !== 1) throw new GatewayLeaseLostError(input.identityId);
        if (!shouldHandleDispatch({ op: 0, t: input.type })) return null;

        const context = await prepareDispatchContext(
          transaction,
          input.identityId,
          input.type,
          input.data,
          now,
        );
        const envelope: GatewayEventEnvelope = {
          version: 2,
          receivedAtMs: now.getTime(),
          eventKey: deriveGatewayEventKey({
            version: 2,
            botIdentityId: input.identityId,
            sessionId: input.sessionId,
            sequence: input.sequence,
            type: input.type,
            data: context.data,
            previousRoleIds: context.previousRoleIds,
            previousNick: context.previousNick,
            emptiedVoiceChannelId: context.emptiedVoiceChannelId,
          }),
          sessionId: input.sessionId,
          sequence: input.sequence,
          type: input.type,
          data: context.data,
          botIdentityId: input.identityId,
          botUserId: input.botUserId,
          previousRoleIds: context.previousRoleIds,
        };
        if (context.previousNick !== undefined) envelope.previousNick = context.previousNick;
        if (input.type === "VOICE_STATE_UPDATE") {
          envelope.emptiedVoiceChannelId = context.emptiedVoiceChannelId;
        }
        await jobs.enqueue(
          {
            queueName: "gateway-events",
            dedupeKey: envelope.eventKey,
            payload: envelope,
            maxAttempts: 4,
            availableAt: now,
          },
          transaction,
        );
        return envelope;
      });
    },

    async cleanupMessageAuditContext(input = {}) {
      const now = new Date(input.nowMs ?? Date.now());
      const retentionMs = readBoundedInteger(
        input.retentionMs ?? MESSAGE_AUDIT_CONTEXT_RETENTION_MS,
        "retentionMs",
        1,
        365 * 24 * 60 * 60_000,
      );
      const maxRows = readBoundedInteger(
        input.maxRowsPerIdentity ?? MESSAGE_AUDIT_CONTEXT_MAX_ROWS,
        "maxRowsPerIdentity",
        1,
        1_000_000,
      );
      const batchSize = readBoundedInteger(input.batchSize ?? 1_000, "batchSize", 1, 10_000);
      const expired = await database.execute(
        `DELETE FROM gateway_message_audit_context
          WHERE ctid IN (
            SELECT ctid FROM gateway_message_audit_context
             WHERE updated_at < $1
             ORDER BY updated_at
             LIMIT $2
          )`,
        [new Date(now.getTime() - retentionMs), batchSize],
      );
      const overflow = await database.execute(
        `DELETE FROM gateway_message_audit_context
          WHERE ctid IN (
            SELECT ctid FROM (
              SELECT ctid,
                     ROW_NUMBER() OVER (
                       PARTITION BY identity_id ORDER BY updated_at DESC, message_id DESC
                     ) AS row_number
                FROM gateway_message_audit_context
            ) ranked
            WHERE row_number > $1
            LIMIT $2
          )`,
        [maxRows, batchSize],
      );
      return expired + overflow;
    },
  };
}

interface GatewaySessionRow extends Record<string, unknown> {
  identity_id: string;
  status: GatewaySnapshot["status"];
  session_id: string | null;
  resume_gateway_url: string | null;
  last_sequence: string | number | null;
  backoff_attempt: number;
  last_error: string | null;
  heartbeat_interval_ms: number | null;
  last_heartbeat_at: Date | null;
  last_heartbeat_ack_at: Date | null;
  fencing_generation: string | number;
  updated_at: Date;
}

interface DispatchContext {
  data: unknown;
  previousRoleIds: string[] | null;
  previousNick?: string | null;
  emptiedVoiceChannelId: string | null;
}

function mapSnapshot(row: GatewaySessionRow): PostgresGatewaySnapshot {
  return {
    status: row.status,
    sessionId: row.session_id,
    resumeGatewayUrl: row.resume_gateway_url,
    lastSequence:
      row.last_sequence === null
        ? null
        : readPostgresSafeInteger(row.last_sequence, "last_sequence"),
    backoffAttempt: row.backoff_attempt,
    lastError: row.last_error,
    heartbeatIntervalMs: row.heartbeat_interval_ms,
    lastHeartbeatAtMs: row.last_heartbeat_at?.getTime() ?? null,
    lastHeartbeatAckAtMs: row.last_heartbeat_ack_at?.getTime() ?? null,
    fencingGeneration: readPostgresSafeInteger(
      row.fencing_generation,
      "gateway fencing_generation",
    ),
    updatedAtMs: row.updated_at.getTime(),
  };
}

async function prepareDispatchContext(
  transaction: PostgresExecutor,
  identityId: string,
  type: string,
  data: unknown,
  now: Date,
): Promise<DispatchContext> {
  let dispatchData = data;
  let previousRoleIds: string[] | null = null;
  let previousNick: string | null | undefined;
  let emptiedVoiceChannelId: string | null = null;
  const record = isRecord(data) ? data : null;

  if (record) {
    const messageId = normalizeId(record.id);
    if (messageId && type === "MESSAGE_DELETE") {
      const cached = await readMessageContext(transaction, identityId, messageId);
      await transaction.execute(
        "DELETE FROM gateway_message_audit_context WHERE identity_id = $1 AND message_id = $2",
        [identityId, messageId],
      );
      if (cached && !isRecord(record.author)) dispatchData = { ...record, author: cached.author };
    } else if (messageId && (type === "MESSAGE_CREATE" || type === "MESSAGE_UPDATE")) {
      const cached = await readMessageContext(transaction, identityId, messageId);
      const guildId = normalizeId(record.guild_id) ?? cached?.guildId;
      const author = isRecord(record.author) ? record.author : cached?.author;
      if (guildId && author && normalizeId(author.id)) {
        await transaction.execute(
          `INSERT INTO gateway_message_audit_context (
             identity_id, message_id, guild_id, author_json, updated_at
           ) VALUES ($1, $2, $3, $4::jsonb, $5)
           ON CONFLICT (identity_id, message_id) DO UPDATE SET
             guild_id = EXCLUDED.guild_id,
             author_json = EXCLUDED.author_json,
             updated_at = EXCLUDED.updated_at`,
          [identityId, messageId, guildId, JSON.stringify(author), now],
        );
      }
      if (!isRecord(record.author) && author) dispatchData = { ...record, author };
    }
  }

  if (record && (type === "GUILD_MEMBER_UPDATE" || type === "GUILD_MEMBER_REMOVE")) {
    const guildId = normalizeId(record.guild_id);
    const userId = isRecord(record.user) ? normalizeId(record.user.id) : null;
    if (guildId && userId) {
      const rows = await transaction.query<{ role_ids_json: unknown }>(
        `SELECT role_ids_json FROM gateway_member_roles
          WHERE identity_id = $1 AND guild_id = $2 AND user_id = $3`,
        [identityId, guildId, userId],
      );
      previousRoleIds = readStringArray(rows[0]?.role_ids_json);
      if (type === "GUILD_MEMBER_UPDATE" && Array.isArray(record.roles)) {
        const roles = record.roles.filter((value): value is string => typeof value === "string");
        await transaction.execute(
          `INSERT INTO gateway_member_roles (identity_id, guild_id, user_id, role_ids_json)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (identity_id, guild_id, user_id) DO UPDATE
             SET role_ids_json = EXCLUDED.role_ids_json`,
          [identityId, guildId, userId, JSON.stringify(roles)],
        );
      } else {
        await transaction.execute(
          `DELETE FROM gateway_member_roles
            WHERE identity_id = $1 AND guild_id = $2 AND user_id = $3`,
          [identityId, guildId, userId],
        );
      }
    }
  }

  if (
    record &&
    (type === "GUILD_MEMBER_ADD" ||
      type === "GUILD_MEMBER_UPDATE" ||
      type === "GUILD_MEMBER_REMOVE")
  ) {
    const guildId = normalizeId(record.guild_id);
    const userId = isRecord(record.user) ? normalizeId(record.user.id) : null;
    if (guildId && userId) {
      const rows = await transaction.query<{ nick_json: unknown }>(
        `SELECT nick_json FROM gateway_member_nicks
          WHERE identity_id = $1 AND guild_id = $2 AND user_id = $3`,
        [identityId, guildId, userId],
      );
      const previous = readNullableString(rows[0]?.nick_json);
      if (type === "GUILD_MEMBER_UPDATE") previousNick = previous;
      if (type === "GUILD_MEMBER_ADD" || type === "GUILD_MEMBER_UPDATE") {
        const nick = typeof record.nick === "string" ? record.nick : null;
        await transaction.execute(
          `INSERT INTO gateway_member_nicks (identity_id, guild_id, user_id, nick_json)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (identity_id, guild_id, user_id) DO UPDATE
             SET nick_json = EXCLUDED.nick_json`,
          [identityId, guildId, userId, JSON.stringify(nick)],
        );
      } else {
        await transaction.execute(
          `DELETE FROM gateway_member_nicks
            WHERE identity_id = $1 AND guild_id = $2 AND user_id = $3`,
          [identityId, guildId, userId],
        );
      }
    }
  }

  if (record && type === "VOICE_STATE_UPDATE") {
    const guildId = normalizeId(record.guild_id);
    const userId = normalizeId(record.user_id);
    if (guildId && userId) {
      const rows = await transaction.query<{ channel_id: string }>(
        `SELECT channel_id FROM gateway_voice_states
          WHERE identity_id = $1 AND guild_id = $2 AND user_id = $3`,
        [identityId, guildId, userId],
      );
      const previousChannelId = normalizeId(rows[0]?.channel_id);
      const nextChannelId = normalizeId(record.channel_id);
      if (nextChannelId) {
        await transaction.execute(
          `INSERT INTO gateway_voice_states (identity_id, guild_id, user_id, channel_id)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (identity_id, guild_id, user_id) DO UPDATE
             SET channel_id = EXCLUDED.channel_id`,
          [identityId, guildId, userId, nextChannelId],
        );
      } else {
        await transaction.execute(
          `DELETE FROM gateway_voice_states
            WHERE identity_id = $1 AND guild_id = $2 AND user_id = $3`,
          [identityId, guildId, userId],
        );
      }
      if (previousChannelId && previousChannelId !== nextChannelId) {
        const counts = await transaction.query<{ count: number }>(
          `SELECT COUNT(*)::INTEGER AS count FROM gateway_voice_states
            WHERE identity_id = $1 AND guild_id = $2 AND channel_id = $3`,
          [identityId, guildId, previousChannelId],
        );
        if ((counts[0]?.count ?? 0) === 0) emptiedVoiceChannelId = previousChannelId;
      }
    }
  }

  return { data: dispatchData, previousRoleIds, previousNick, emptiedVoiceChannelId };
}

async function readMessageContext(
  transaction: PostgresExecutor,
  identityId: string,
  messageId: string,
): Promise<{ guildId: string; author: Record<string, unknown> } | null> {
  const rows = await transaction.query<{ guild_id: string; author_json: unknown }>(
    `SELECT guild_id, author_json FROM gateway_message_audit_context
      WHERE identity_id = $1 AND message_id = $2`,
    [identityId, messageId],
  );
  const row = rows[0];
  return row && isRecord(row.author_json)
    ? { guildId: row.guild_id, author: row.author_json }
    : null;
}

async function requireLease(
  transaction: PostgresExecutor,
  lease: PostgresLease,
  now: Date,
): Promise<void> {
  const rows = await transaction.query<{ present: number }>(
    `SELECT 1 AS present FROM scheduler_leases
      WHERE name = $1 AND owner_id = $2 AND lease_token = $3
        AND fencing_generation = $4 AND lease_expires_at > $5
      FOR UPDATE`,
    [lease.name, lease.ownerId, lease.leaseToken, lease.fencingGeneration, now],
  );
  if (!rows[0]) throw new GatewayLeaseLostError(lease.name.slice("gateway:".length));
}

function assertLeaseMatches(identityId: string, lease: PostgresLease): void {
  if (lease.name !== `gateway:${identityId}`) throw new GatewayLeaseLostError(identityId);
}

function readStringArray(value: unknown): string[] | null {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : null;
}

function readNullableString(value: unknown): string | null | undefined {
  return typeof value === "string" ? value : value === null ? null : undefined;
}

function readOptionalDate(value: number | null | undefined): Date | null {
  return value === undefined || value === null ? null : new Date(value);
}

function readBoundedInteger(value: number, name: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}

function assertIdentifier(value: string, name: string): void {
  if (!value || value.length > 512 || [...value].some((entry) => entry.codePointAt(0)! < 32)) {
    throw new Error(`${name} must be a non-empty bounded identifier.`);
  }
}

function normalizeId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
