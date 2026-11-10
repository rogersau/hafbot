import type { Env } from "../env";
import {
  buildHeartbeatPayload,
  buildIdentifyPayload,
  buildResumePayload,
  nextBackoffMillis,
  shouldHandleDispatch,
} from "../gateway";
import type { GatewayEventEnvelope } from "../runtime/gateway-event-queue-consumer";
import { deriveGatewayEventKey } from "../runtime/gateway-event-idempotency";
import type { DiscordGuildMemberUpdate } from "../services/gateway/event-types";
import { isRecord } from "../unknown-parse";

interface DiscordVoiceStateUpdate {
  guild_id?: string;
  user_id?: string;
  channel_id?: string | null;
}

const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const MESSAGE_AUDIT_CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MESSAGE_AUDIT_CONTEXT_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const MESSAGE_AUDIT_CONTEXT_MAX_ROWS = 100_000;

type GatewayStatus = "idle" | "connecting" | "ready" | "resuming" | "backoff";

interface GatewaySessionSnapshot {
  status: GatewayStatus;
  sessionId: string | null;
  resumeGatewayUrl: string | null;
  lastSequence: number | null;
  backoffAttempt: number;
  lastError: string | null;
  heartbeatIntervalMs: number | null;
}

interface GatewayEnvelope {
  op: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

export class GatewaySessionSqliteDO implements DurableObject {
  private readonly sql: DurableObjectStorage["sql"];
  private readonly env: Env;
  private readonly ctx: DurableObjectState;
  private readonly gatewayEnabled: boolean;
  private socket: WebSocket | null = null;
  private snapshot: GatewaySessionSnapshot;
  private discordBotToken: string;
  private botIdentityId = "standard";
  private botUserId: string;
  private nextMessageAuditContextCleanupAtMs = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    this.gatewayEnabled = isGatewayEnabled(env.GATEWAY_ENABLED);
    this.discordBotToken = env.DISCORD_BOT_TOKEN;
    this.botUserId = env.BOT_USER_ID;
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS gateway_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS gateway_member_roles (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role_ids_json TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS gateway_member_nicks (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        nick_json TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
      CREATE TABLE IF NOT EXISTS gateway_message_audit_context (
        message_id TEXT PRIMARY KEY,
        guild_id TEXT NOT NULL,
        author_json TEXT NOT NULL,
        updated_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS gateway_message_audit_context_updated_at_idx
        ON gateway_message_audit_context(updated_at_ms DESC, message_id DESC);
      CREATE TABLE IF NOT EXISTS gateway_voice_states (
        guild_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        PRIMARY KEY (guild_id, user_id)
      );
    `);
    this.snapshot = this.loadSnapshot();

    if (!this.gatewayEnabled && this.snapshot.status !== "idle") {
      this.ctx.blockConcurrencyWhile(() => this.stop());
    } else if (this.snapshot.status !== "idle") {
      this.cleanupMessageAuditContext(Date.now());
      this.ctx.blockConcurrencyWhile(() => this.scheduleAlarm(1_000));
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json(this.publicSnapshot());
    }

    if (request.method === "POST" && url.pathname === "/start") {
      if (!this.gatewayEnabled) {
        await this.stop();
        return Response.json(this.publicSnapshot());
      }
      if (this.snapshot.status === "idle") {
        this.cleanupMessageAuditContext(Date.now());
      }
      this.discordBotToken =
        request.headers.get("X-Discord-Bot-Token") || this.env.DISCORD_BOT_TOKEN;
      this.botIdentityId = request.headers.get("X-Gateway-Bot-Identity") || "standard";
      this.botUserId = request.headers.get("X-Gateway-Bot-User-Id") || this.env.BOT_USER_ID;
      await this.start();
      return Response.json(this.publicSnapshot());
    }

    if (request.method === "POST" && url.pathname === "/stop") {
      await this.stop();
      return Response.json(this.publicSnapshot());
    }

    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    if (!this.gatewayEnabled) {
      await this.stop();
      return;
    }
    if (this.snapshot.status === "backoff" || (!this.socket && this.snapshot.status !== "idle")) {
      await this.start();
      return;
    }

    if (!this.socket || this.snapshot.heartbeatIntervalMs === null) {
      return;
    }

    try {
      this.socket.send(JSON.stringify(buildHeartbeatPayload(this.snapshot.lastSequence)));
      this.snapshot.lastError = null;
      this.deleteValue("last_error");
    } catch {
      this.snapshot.lastError = "Failed to send heartbeat";
      this.persistValue("last_error", this.snapshot.lastError);
    }
    await this.scheduleAlarm(this.snapshot.heartbeatIntervalMs);
  }

  private async start(): Promise<void> {
    if (this.socket && this.socket.readyState !== WebSocket.CLOSED) {
      return;
    }

    const shouldResume = this.canResume();
    this.snapshot.status = shouldResume ? "resuming" : "connecting";
    this.persistValue("status", this.snapshot.status);

    const socket = new WebSocket(this.snapshot.resumeGatewayUrl ?? DEFAULT_GATEWAY_URL);
    socket.addEventListener("message", async (event) => {
      if (this.socket !== socket) {
        return;
      }
      await this.handleSocketMessage(event);
    });
    socket.addEventListener("close", () => {
      if (this.socket !== socket) {
        return;
      }
      this.socket = null;

      if (this.snapshot.status === "idle" || this.snapshot.status === "backoff") {
        return;
      }

      void this.enterBackoff();
    });
    socket.addEventListener("error", async () => {
      if (this.socket !== socket) {
        return;
      }
      this.snapshot.lastError = "Gateway websocket error";
      this.persistValue("last_error", this.snapshot.lastError);

      this.socket = null;
      if (this.snapshot.status === "idle" || this.snapshot.status === "backoff") {
        return;
      }

      socket.close();
      await this.enterBackoff();
    });
    this.socket = socket;
  }

  private async stop(): Promise<void> {
    if (this.snapshot.status === "idle" && !this.socket) {
      await this.ctx.storage.deleteAlarm();
      return;
    }

    const socket = this.socket;
    this.socket = null;
    this.snapshot = {
      status: "idle",
      sessionId: null,
      resumeGatewayUrl: null,
      lastSequence: null,
      backoffAttempt: 0,
      lastError: null,
      heartbeatIntervalMs: null,
    };
    this.persistValue("status", "idle");
    this.deleteValue("session_id");
    this.deleteValue("resume_gateway_url");
    this.deleteValue("last_sequence");
    this.deleteValue("backoff_attempt");
    this.deleteValue("last_error");
    this.deleteValue("heartbeat_interval_ms");
    await this.ctx.storage.deleteAlarm();

    if (socket && socket.readyState !== WebSocket.CLOSED) {
      try {
        socket.close(1000, "Gateway session stopped");
      } catch (error) {
        this.socket = socket;
        throw error;
      }
    }
  }

  private async handleSocketMessage(event: { data: unknown }): Promise<void> {
    try {
      if (typeof event.data !== "string") {
        return;
      }

      const payload = JSON.parse(event.data) as GatewayEnvelope;

      if (typeof payload.s === "number") {
        this.snapshot.lastSequence = payload.s;
        this.persistValue("last_sequence", String(payload.s));
      }

      if (payload.op === 10) {
        await this.handleHello(payload.d);
        return;
      }

      if (payload.op === 9) {
        await this.handleInvalidSession(payload.d === true);
        return;
      }

      if (payload.op !== 0) {
        return;
      }

      this.enqueueGatewayDispatch(payload);

      if (payload.t === "READY" && isReadyPayload(payload.d)) {
        this.snapshot.sessionId = payload.d.session_id;
        this.snapshot.resumeGatewayUrl = payload.d.resume_gateway_url;
        this.snapshot.status = "ready";
        this.snapshot.backoffAttempt = 0;
        this.snapshot.lastError = null;
        this.persistValue("session_id", payload.d.session_id);
        this.persistValue("resume_gateway_url", payload.d.resume_gateway_url);
        this.persistValue("status", "ready");
        this.persistValue("backoff_attempt", "0");
        this.deleteValue("last_error");
        return;
      }

      if (payload.t === "RESUMED") {
        this.snapshot.status = "ready";
        this.snapshot.backoffAttempt = 0;
        this.snapshot.lastError = null;
        this.persistValue("status", "ready");
        this.persistValue("backoff_attempt", "0");
        this.deleteValue("last_error");
      }
    } catch {
      this.snapshot.lastError = "Failed to parse gateway message";
      this.persistValue("last_error", this.snapshot.lastError);
    }
  }

  private enqueueGatewayDispatch(payload: GatewayEnvelope): void {
    if (!shouldHandleDispatch({ op: payload.op, t: payload.t ?? null }) || !payload.t) {
      return;
    }

    const dispatchData = this.prepareMessageAuditContextForDispatch(payload.t, payload.d);
    const previousRoleIds = this.updateRoleCacheForDispatch(payload.t, payload.d);
    const previousNick = this.updateNickCacheForDispatch(payload.t, payload.d);
    const emptiedVoiceChannelId = this.updateVoiceCacheForDispatch(payload.t, payload.d);
    const envelope: GatewayEventEnvelope = {
      version: 2,
      receivedAtMs: Date.now(),
      eventKey: deriveGatewayEventKey({
        version: 2,
        botIdentityId: this.botIdentityId,
        sessionId: this.snapshot.sessionId,
        sequence: payload.s ?? null,
        type: payload.t,
        data: dispatchData,
        previousRoleIds,
        previousNick,
        emptiedVoiceChannelId,
      }),
      sessionId: this.snapshot.sessionId,
      sequence: payload.s ?? null,
      type: payload.t,
      data: dispatchData,
      botIdentityId: this.botIdentityId,
      botUserId: this.botUserId,
      previousRoleIds,
    };
    if (previousNick !== undefined) {
      envelope.previousNick = previousNick;
    }
    if (payload.t === "VOICE_STATE_UPDATE") {
      envelope.emptiedVoiceChannelId = emptiedVoiceChannelId;
    }

    this.ctx.waitUntil(this.env.GATEWAY_EVENT_QUEUE.send(envelope));
  }

  private async handleHello(data: unknown): Promise<void> {
    const heartbeatIntervalMs = getHeartbeatInterval(data);
    if (heartbeatIntervalMs === null || !this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }

    this.snapshot.heartbeatIntervalMs = heartbeatIntervalMs;
    this.persistValue("heartbeat_interval_ms", String(heartbeatIntervalMs));
    await this.scheduleAlarm(heartbeatIntervalMs);

    if (this.canResume()) {
      this.socket.send(
        JSON.stringify(
          buildResumePayload(
            this.discordBotToken,
            this.snapshot.sessionId as string,
            this.snapshot.lastSequence as number,
          ),
        ),
      );
      this.snapshot.status = "resuming";
      this.persistValue("status", "resuming");
      return;
    }

    this.socket.send(JSON.stringify(buildIdentifyPayload(this.discordBotToken)));
    this.snapshot.status = "connecting";
    this.persistValue("status", "connecting");
  }

  private async handleInvalidSession(canResume: boolean): Promise<void> {
    const currentSocket = this.socket;
    this.socket = null;

    if (!canResume) {
      this.snapshot.sessionId = null;
      this.snapshot.resumeGatewayUrl = null;
      this.snapshot.lastSequence = null;
      this.deleteValue("session_id");
      this.deleteValue("resume_gateway_url");
      this.deleteValue("last_sequence");
    }

    await this.enterBackoff();

    if (currentSocket) {
      currentSocket.close();
    }
  }

  private canResume(): boolean {
    return (
      this.snapshot.sessionId !== null &&
      this.snapshot.resumeGatewayUrl !== null &&
      this.snapshot.lastSequence !== null
    );
  }

  private async scheduleAlarm(delayMs: number): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + delayMs);
  }

  private async enterBackoff(): Promise<void> {
    const delayMs = nextBackoffMillis(this.snapshot.backoffAttempt);
    this.snapshot.backoffAttempt += 1;
    this.snapshot.status = "backoff";
    this.persistValue("backoff_attempt", String(this.snapshot.backoffAttempt));
    this.persistValue("status", "backoff");
    await this.scheduleAlarm(delayMs);
  }

  private publicSnapshot() {
    return {
      status: this.snapshot.status,
      sessionId: this.snapshot.sessionId,
      resumeGatewayUrl: this.snapshot.resumeGatewayUrl,
      lastSequence: this.snapshot.lastSequence,
      backoffAttempt: this.snapshot.backoffAttempt,
      lastError: this.snapshot.lastError,
      heartbeatIntervalMs: this.snapshot.heartbeatIntervalMs,
    };
  }

  private loadSnapshot(): GatewaySessionSnapshot {
    const rows = [...this.sql.exec("SELECT key, value FROM gateway_state")].map((row) => ({
      key: row.key as string,
      value: row.value as string,
    }));
    const values = new Map(rows.map((row) => [row.key, row.value]));

    return {
      status: parseGatewayStatus(values.get("status")),
      sessionId: values.get("session_id") ?? null,
      resumeGatewayUrl: values.get("resume_gateway_url") ?? null,
      lastSequence: parseOptionalNumber(values.get("last_sequence")),
      backoffAttempt: parseOptionalNumber(values.get("backoff_attempt")) ?? 0,
      lastError: values.get("last_error") ?? null,
      heartbeatIntervalMs: parseOptionalNumber(values.get("heartbeat_interval_ms")),
    };
  }

  private persistValue(key: string, value: string): void {
    this.sql.exec(
      "INSERT INTO gateway_state(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      value,
    );
  }

  private deleteValue(key: string): void {
    this.sql.exec("DELETE FROM gateway_state WHERE key = ?", key);
  }

  private updateRoleCacheForDispatch(type: string, data: unknown): string[] | null {
    if (type !== "GUILD_MEMBER_UPDATE" && type !== "GUILD_MEMBER_REMOVE") {
      return null;
    }

    const member = data as DiscordGuildMemberUpdate | null;
    const guildId = normalizeId(member?.guild_id);
    const userId = normalizeId(member?.user?.id);
    if (!guildId || !userId) {
      return null;
    }

    const previousRoleIds = this.readCachedMemberRoleIds(guildId, userId);
    if (type === "GUILD_MEMBER_UPDATE" && Array.isArray(member?.roles)) {
      this.writeCachedMemberRoleIds(guildId, userId, member.roles);
    }
    if (type === "GUILD_MEMBER_REMOVE") {
      this.deleteCachedMemberRoleIds(guildId, userId);
    }

    return previousRoleIds;
  }

  private prepareMessageAuditContextForDispatch(type: string, data: unknown): unknown {
    if (!isRecord(data)) return data;
    const messageId = normalizeId(data.id);
    if (!messageId) return data;

    if (type === "MESSAGE_DELETE") {
      const cached = this.readMessageAuditContext(messageId);
      this.deleteMessageAuditContext(messageId);
      if (!cached) return data;
      return {
        ...data,
        author: isRecord(data.author) ? data.author : cached.author,
      };
    }

    if (type !== "MESSAGE_CREATE" && type !== "MESSAGE_UPDATE") return data;
    const cached = this.readMessageAuditContext(messageId);
    const guildId = normalizeId(data.guild_id) ?? cached?.guildId;
    const author = isRecord(data.author) ? data.author : cached?.author;
    if (guildId && author && normalizeId(author.id)) {
      this.writeMessageAuditContext(messageId, guildId, author);
    }
    return isRecord(data.author) || !author ? data : { ...data, author };
  }

  private readMessageAuditContext(messageId: string): {
    guildId: string;
    author: Record<string, unknown>;
  } | null {
    const iterator = this.sql.exec(
      "SELECT guild_id, author_json FROM gateway_message_audit_context WHERE message_id = ? LIMIT 1",
      messageId,
    );
    const row = iterator.next().value as { guild_id?: string; author_json?: string } | undefined;
    if (!row?.guild_id || !row.author_json) return null;
    try {
      const author = JSON.parse(row.author_json) as unknown;
      if (!isRecord(author)) return null;
      return { guildId: row.guild_id, author };
    } catch {
      return null;
    }
  }

  private writeMessageAuditContext(
    messageId: string,
    guildId: string,
    author: Record<string, unknown>,
  ): void {
    const now = Date.now();
    this.sql.exec(
      "INSERT INTO gateway_message_audit_context(message_id, guild_id, author_json, updated_at_ms) VALUES(?, ?, ?, ?) ON CONFLICT(message_id) DO UPDATE SET guild_id = excluded.guild_id, author_json = excluded.author_json, updated_at_ms = excluded.updated_at_ms",
      messageId,
      guildId,
      JSON.stringify(author),
      now,
    );
    if (now >= this.nextMessageAuditContextCleanupAtMs) {
      this.cleanupMessageAuditContext(now);
    }
  }

  private cleanupMessageAuditContext(nowMs: number): void {
    this.nextMessageAuditContextCleanupAtMs = nowMs + MESSAGE_AUDIT_CONTEXT_CLEANUP_INTERVAL_MS;
    this.sql.exec(
      "DELETE FROM gateway_message_audit_context WHERE updated_at_ms < ?",
      nowMs - MESSAGE_AUDIT_CONTEXT_RETENTION_MS,
    );
    this.sql.exec(
      "DELETE FROM gateway_message_audit_context WHERE message_id IN (SELECT message_id FROM gateway_message_audit_context ORDER BY updated_at_ms DESC, message_id DESC LIMIT -1 OFFSET ?)",
      MESSAGE_AUDIT_CONTEXT_MAX_ROWS,
    );
  }

  private deleteMessageAuditContext(messageId: string): void {
    this.sql.exec("DELETE FROM gateway_message_audit_context WHERE message_id = ?", messageId);
  }

  private updateNickCacheForDispatch(type: string, data: unknown): string | null | undefined {
    if (
      type !== "GUILD_MEMBER_ADD" &&
      type !== "GUILD_MEMBER_UPDATE" &&
      type !== "GUILD_MEMBER_REMOVE"
    ) {
      return undefined;
    }
    const member = data as DiscordGuildMemberUpdate | null;
    const guildId = normalizeId(member?.guild_id);
    const userId = normalizeId(member?.user?.id);
    if (!guildId || !userId) return undefined;

    const previousNick = this.readCachedMemberNick(guildId, userId);
    if (type === "GUILD_MEMBER_ADD" || type === "GUILD_MEMBER_UPDATE") {
      this.writeCachedMemberNick(guildId, userId, member?.nick ?? null);
    } else {
      this.deleteCachedMemberNick(guildId, userId);
    }
    return type === "GUILD_MEMBER_UPDATE" ? previousNick : undefined;
  }

  private readCachedMemberNick(guildId: string, userId: string): string | null | undefined {
    const iterator = this.sql.exec(
      "SELECT nick_json FROM gateway_member_nicks WHERE guild_id = ? AND user_id = ? LIMIT 1",
      guildId,
      userId,
    );
    const row = iterator.next().value as { nick_json?: string } | undefined;
    if (!row?.nick_json) return undefined;
    try {
      const nick = JSON.parse(row.nick_json) as unknown;
      return typeof nick === "string" ? nick : nick === null ? null : undefined;
    } catch {
      return undefined;
    }
  }

  private writeCachedMemberNick(guildId: string, userId: string, nick: string | null): void {
    this.sql.exec(
      "INSERT INTO gateway_member_nicks(guild_id, user_id, nick_json) VALUES(?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET nick_json = excluded.nick_json",
      guildId,
      userId,
      JSON.stringify(nick),
    );
  }

  private deleteCachedMemberNick(guildId: string, userId: string): void {
    this.sql.exec(
      "DELETE FROM gateway_member_nicks WHERE guild_id = ? AND user_id = ?",
      guildId,
      userId,
    );
  }

  private readCachedMemberRoleIds(guildId: string, userId: string): string[] | null {
    const iterator = this.sql.exec(
      "SELECT role_ids_json FROM gateway_member_roles WHERE guild_id = ? AND user_id = ? LIMIT 1",
      guildId,
      userId,
    );
    const row = iterator.next().value as { role_ids_json?: string } | undefined;
    if (!row?.role_ids_json) {
      return null;
    }

    try {
      const parsed = JSON.parse(row.role_ids_json) as unknown;
      return Array.isArray(parsed)
        ? parsed.filter((roleId): roleId is string => typeof roleId === "string")
        : null;
    } catch {
      return null;
    }
  }

  private writeCachedMemberRoleIds(guildId: string, userId: string, roleIds: string[]): void {
    this.sql.exec(
      "INSERT INTO gateway_member_roles(guild_id, user_id, role_ids_json) VALUES(?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET role_ids_json = excluded.role_ids_json",
      guildId,
      userId,
      JSON.stringify(roleIds),
    );
  }

  private deleteCachedMemberRoleIds(guildId: string, userId: string): void {
    this.sql.exec(
      "DELETE FROM gateway_member_roles WHERE guild_id = ? AND user_id = ?",
      guildId,
      userId,
    );
  }

  private updateVoiceCacheForDispatch(type: string, data: unknown): string | null {
    if (type !== "VOICE_STATE_UPDATE") {
      return null;
    }

    const voiceState = data as DiscordVoiceStateUpdate | null;
    const guildId = normalizeId(voiceState?.guild_id);
    const userId = normalizeId(voiceState?.user_id);
    if (!guildId || !userId) {
      return null;
    }

    const previousChannelId = this.readCachedVoiceChannelId(guildId, userId);
    const nextChannelId = normalizeId(voiceState?.channel_id);
    if (nextChannelId) {
      this.writeCachedVoiceChannelId(guildId, userId, nextChannelId);
    } else {
      this.deleteCachedVoiceChannelId(guildId, userId);
    }

    if (!previousChannelId || previousChannelId === nextChannelId) {
      return null;
    }
    return this.countCachedVoiceChannelMembers(guildId, previousChannelId) === 0
      ? previousChannelId
      : null;
  }

  private readCachedVoiceChannelId(guildId: string, userId: string): string | null {
    const iterator = this.sql.exec(
      "SELECT channel_id FROM gateway_voice_states WHERE guild_id = ? AND user_id = ? LIMIT 1",
      guildId,
      userId,
    );
    const row = iterator.next().value as { channel_id?: string } | undefined;
    return normalizeId(row?.channel_id);
  }

  private writeCachedVoiceChannelId(guildId: string, userId: string, channelId: string): void {
    this.sql.exec(
      "INSERT INTO gateway_voice_states(guild_id, user_id, channel_id) VALUES(?, ?, ?) ON CONFLICT(guild_id, user_id) DO UPDATE SET channel_id = excluded.channel_id",
      guildId,
      userId,
      channelId,
    );
  }

  private deleteCachedVoiceChannelId(guildId: string, userId: string): void {
    this.sql.exec(
      "DELETE FROM gateway_voice_states WHERE guild_id = ? AND user_id = ?",
      guildId,
      userId,
    );
  }

  private countCachedVoiceChannelMembers(guildId: string, channelId: string): number {
    const iterator = this.sql.exec(
      "SELECT COUNT(*) AS count FROM gateway_voice_states WHERE guild_id = ? AND channel_id = ?",
      guildId,
      channelId,
    );
    const row = iterator.next().value as { count?: number } | undefined;
    return Number(row?.count ?? 0);
  }
}

function parseGatewayStatus(value: string | undefined): GatewayStatus {
  if (value === "connecting" || value === "ready" || value === "resuming" || value === "backoff") {
    return value;
  }

  return "idle";
}

function parseOptionalNumber(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getHeartbeatInterval(data: unknown): number | null {
  if (!isRecord(data) || typeof data.heartbeat_interval !== "number") {
    return null;
  }

  return data.heartbeat_interval;
}

function isReadyPayload(data: unknown): data is { session_id: string; resume_gateway_url: string } {
  return (
    isRecord(data) &&
    typeof data.session_id === "string" &&
    typeof data.resume_gateway_url === "string"
  );
}

function normalizeId(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isGatewayEnabled(value: unknown): boolean {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes";
}
