import { randomUUID } from "node:crypto";

import {
  buildHeartbeatPayload,
  buildIdentifyPayload,
  buildResumePayload,
  nextBackoffMillis,
} from "../gateway";
import type { ManagedNodeComponent } from "./host";
import {
  GATEWAY_SOCKET_OPEN,
  createNodeGatewaySocket,
  type GatewaySocket,
  type GatewaySocketFactory,
} from "./gateway-socket";
import type { GatewaySnapshot } from "../runtime/contracts";
import type { PostgresGatewayStateStore } from "../runtime/postgres/postgres-gateway-store";
import { isRecord } from "../unknown-parse";
import type { PostgresLease, PostgresLeaseStore } from "../runtime/postgres/postgres-lease-store";

const DEFAULT_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const NON_RESUMABLE_CLOSE_CODES = new Set([
  1000, 1001, 4003, 4004, 4005, 4007, 4009, 4010, 4011, 4012, 4013, 4014,
]);

export interface GatewayIdentityConfig {
  identityId: string;
  botUserId: string;
  token: string;
}

export interface PostgresGatewaySupervisorOptions {
  store: PostgresGatewayStateStore;
  leases: PostgresLeaseStore;
  listIdentities(): Promise<GatewayIdentityConfig[]>;
  ownerId?: string;
  leaseMs?: number;
  tickIntervalMs?: number;
  identityRefreshMs?: number;
  socketFactory?: GatewaySocketFactory;
  now?: () => number;
  random?: () => number;
  onError?: (error: unknown, context: { identityId?: string }) => void;
}

export interface GatewayIdentityStatus extends GatewaySnapshot {
  identityId: string;
  leadership: "leader" | "standby";
  fencingGeneration: number | null;
  leaseExpiresAt: string | null;
  heartbeatAwaitingAck: boolean;
}

export interface PostgresGatewaySupervisorStatus {
  state: "created" | "running" | "stopping" | "stopped";
  ownerId: string;
  identities: GatewayIdentityStatus[];
}

export interface PostgresGatewaySupervisor extends ManagedNodeComponent {
  status(): PostgresGatewaySupervisorStatus;
}

export function createPostgresGatewaySupervisor(
  options: PostgresGatewaySupervisorOptions,
): PostgresGatewaySupervisor {
  const ownerId = options.ownerId ?? `gateway-${randomUUID()}`;
  const leaseMs = readDuration(options.leaseMs ?? 30_000, "leaseMs", 15 * 60_000);
  const tickIntervalMs = readDuration(options.tickIntervalMs ?? 5_000, "tickIntervalMs", 60_000);
  if (tickIntervalMs > Math.floor(leaseMs / 2)) {
    throw new Error("tickIntervalMs must be no more than half of leaseMs.");
  }
  const identityRefreshMs = readDuration(
    options.identityRefreshMs ?? 60_000,
    "identityRefreshMs",
    24 * 60 * 60_000,
  );
  const socketFactory = options.socketFactory ?? createNodeGatewaySocket;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  let state: PostgresGatewaySupervisorStatus["state"] = "created";
  const sessions = new Map<string, GatewayIdentitySession>();
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let syncing = false;

  return {
    async start() {
      if (state === "running") {
        await syncIdentities();
        return;
      }
      if (state !== "created") throw new Error(`Cannot start Gateway supervisor from ${state}.`);
      state = "running";
      await syncIdentities();
      refreshTimer = setInterval(() => void syncIdentities(), identityRefreshMs);
      refreshTimer.unref?.();
    },

    async stop() {
      if (state === "stopped") return;
      state = "stopping";
      if (refreshTimer) clearInterval(refreshTimer);
      refreshTimer = undefined;
      await Promise.all([...sessions.values()].map((session) => session.stop()));
      sessions.clear();
      state = "stopped";
    },

    isReady() {
      return state === "running" && sessions.size > 0;
    },

    status() {
      return {
        state,
        ownerId,
        identities: [...sessions.values()]
          .map((session) => session.status())
          .sort((left, right) => left.identityId.localeCompare(right.identityId)),
      };
    },
  };

  async function syncIdentities(): Promise<void> {
    if (syncing || state !== "running") return;
    syncing = true;
    try {
      const identities = await options.listIdentities();
      const desired = new Map<string, GatewayIdentityConfig>();
      for (const identity of identities) {
        validateIdentity(identity);
        if (desired.has(identity.identityId)) {
          throw new Error(`Duplicate Gateway identity: ${identity.identityId}.`);
        }
        desired.set(identity.identityId, identity);
      }
      for (const [identityId, session] of sessions) {
        const config = desired.get(identityId);
        if (!config || !session.matches(config)) {
          await session.stop();
          sessions.delete(identityId);
        }
      }
      for (const config of desired.values()) {
        if (sessions.has(config.identityId)) continue;
        const session = createGatewayIdentitySession({
          config,
          ownerId,
          store: options.store,
          leases: options.leases,
          leaseMs,
          tickIntervalMs,
          socketFactory,
          now,
          random,
          onError: options.onError,
        });
        sessions.set(config.identityId, session);
        await session.start();
      }
    } catch (error) {
      options.onError?.(error, {});
      if (sessions.size === 0) throw error;
    } finally {
      syncing = false;
    }
  }
}

interface GatewayIdentitySessionOptions {
  config: GatewayIdentityConfig;
  ownerId: string;
  store: PostgresGatewayStateStore;
  leases: PostgresLeaseStore;
  leaseMs: number;
  tickIntervalMs: number;
  socketFactory: GatewaySocketFactory;
  now: () => number;
  random: () => number;
  onError?: (error: unknown, context: { identityId?: string }) => void;
}

interface GatewayIdentitySession {
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): GatewayIdentityStatus;
  matches(config: GatewayIdentityConfig): boolean;
}

function createGatewayIdentitySession(
  options: GatewayIdentitySessionOptions,
): GatewayIdentitySession {
  let active = false;
  let lease: PostgresLease | null = null;
  let socket: GatewaySocket | null = null;
  let tickTimer: ReturnType<typeof setInterval> | undefined;
  let heartbeatTimer: ReturnType<typeof setTimeout> | undefined;
  let ticking = false;
  let closing = false;
  let heartbeatAwaitingAck = false;
  let nextReconnectAtMs = 0;
  let messageChain = Promise.resolve();
  // Heartbeats acknowledge received frames; snapshot.lastSequence is committed resume progress.
  let receivedSequence: number | null = null;
  let snapshot: GatewaySnapshot = emptySnapshot();

  return {
    async start() {
      if (active) return;
      active = true;
      await tick();
      if (!active) return;
      tickTimer = setInterval(() => void tick(), options.tickIntervalMs);
      tickTimer.unref?.();
    },

    async stop() {
      if (!active && !lease) return;
      active = false;
      if (tickTimer) clearInterval(tickTimer);
      tickTimer = undefined;
      clearHeartbeat();
      const currentSocket = socket;
      socket = null;
      currentSocket?.terminate();
      await messageChain.catch(() => undefined);
      const currentLease = lease;
      lease = null;
      if (currentLease) {
        await options.leases
          .release(currentLease)
          .catch((error) => options.onError?.(error, { identityId: options.config.identityId }));
      }
    },

    status() {
      return {
        ...snapshot,
        identityId: options.config.identityId,
        leadership: lease ? "leader" : "standby",
        fencingGeneration: lease?.fencingGeneration ?? null,
        leaseExpiresAt: lease?.leaseExpiresAt.toISOString() ?? null,
        heartbeatAwaitingAck,
      };
    },

    matches(config) {
      return (
        config.identityId === options.config.identityId &&
        config.botUserId === options.config.botUserId &&
        config.token === options.config.token
      );
    },
  };

  async function tick(): Promise<void> {
    if (!active || ticking) return;
    ticking = true;
    try {
      if (!lease) {
        const acquired = await options.leases.acquire(
          `gateway:${options.config.identityId}`,
          options.ownerId,
          options.leaseMs,
          new Date(options.now()),
        );
        if (!active) {
          if (acquired) await options.leases.release(acquired);
          return;
        }
        lease = acquired;
        if (lease) {
          const currentLease = lease;
          const stored = await options.store.read(options.config.identityId);
          if (!active || !hasLease(currentLease)) return;
          snapshot = stored ? copyGatewaySnapshot(stored) : emptySnapshot();
          receivedSequence = snapshot.lastSequence;
          nextReconnectAtMs = options.now();
        }
      } else {
        const currentLease = lease;
        const renewed = await options.leases.renew(
          currentLease,
          options.leaseMs,
          new Date(options.now()),
        );
        if (!active || !hasLease(currentLease)) return;
        lease = renewed;
        if (!lease) {
          loseLeadership(new Error("Gateway lease renewal was fenced."));
          return;
        }
      }
      if (lease && !socket && !closing && options.now() >= nextReconnectAtMs) await connect();
    } catch (error) {
      loseLeadership(error);
    } finally {
      ticking = false;
    }
  }

  async function connect(): Promise<void> {
    if (!active || !lease || socket) return;
    const currentLease = lease;
    snapshot.status = canResume(snapshot) ? "resuming" : "connecting";
    if (!(await persist())) {
      loseLeadership(new Error("Gateway state write was fenced before connect."), currentLease);
      return;
    }
    if (!active || !hasLease(currentLease) || socket || closing) return;
    const url = appendGatewayParameters(snapshot.resumeGatewayUrl ?? DEFAULT_GATEWAY_URL);
    let candidate: GatewaySocket;
    try {
      candidate = options.socketFactory(url, {
        open() {},
        message(text) {
          if (socket !== candidate) return;
          const messageLease = lease;
          if (!messageLease) return;
          messageChain = messageChain
            .then(() => handleMessage(text, candidate))
            .catch((error) => loseLeadership(error, messageLease));
        },
        close(code) {
          if (socket !== candidate) return;
          socket = null;
          clearHeartbeat();
          if (!active || !lease) return;
          const closingLease = lease;
          closing = true;
          messageChain = messageChain
            .then(async () => {
              if (!active || !hasLease(closingLease)) return;
              if (NON_RESUMABLE_CLOSE_CODES.has(code)) await clearResumeState();
              await enterBackoff(`Gateway websocket closed (${code}).`);
            })
            .catch((error) => loseLeadership(error, closingLease))
            .finally(() => {
              closing = false;
            });
        },
        error(error) {
          if (socket !== candidate) return;
          options.onError?.(error, { identityId: options.config.identityId });
        },
      });
    } catch (error) {
      await enterBackoff("Gateway websocket connection failed.");
      options.onError?.(error, { identityId: options.config.identityId });
      return;
    }
    socket = candidate;
  }

  async function handleMessage(text: string, currentSocket: GatewaySocket): Promise<void> {
    if (!active || !lease || socket !== currentSocket) return;
    const currentLease = lease;
    let payload: GatewayEnvelope;
    try {
      payload = JSON.parse(text) as GatewayEnvelope;
    } catch {
      snapshot.lastError = "Failed to parse Gateway message.";
      await requirePersist();
      return;
    }
    if (!Number.isInteger(payload.op)) return;
    if (payload.op === 10) {
      await handleHello(payload.d);
      return;
    }
    if (payload.op === 11) {
      heartbeatAwaitingAck = false;
      await requirePersist({ lastHeartbeatAckAtMs: options.now() });
      return;
    }
    if (payload.op === 1) {
      await sendHeartbeat(true);
      return;
    }
    if (payload.op === 7) {
      reconnectImmediately();
      return;
    }
    if (payload.op === 9) {
      if (payload.d !== true) await clearResumeState();
      if (!active || !hasLease(currentLease) || socket !== currentSocket) return;
      await reconnectWithBackoff("Gateway session was invalid.");
      return;
    }
    if (payload.op !== 0 || typeof payload.t !== "string") return;
    if (typeof payload.s === "number" && Number.isSafeInteger(payload.s)) {
      receivedSequence = payload.s;
    }
    const ready =
      payload.t === "READY" && isReadyPayload(payload.d)
        ? { sessionId: payload.d.session_id, resumeGatewayUrl: payload.d.resume_gateway_url }
        : undefined;
    if (
      payload.t === "READY" &&
      (!ready || typeof payload.s !== "number" || !Number.isSafeInteger(payload.s))
    ) {
      throw new Error("Gateway READY requires a session and its sequence.");
    }
    const sequence = receivedSequence;
    await options.store.dispatch({
      identityId: options.config.identityId,
      botUserId: options.config.botUserId,
      lease: currentLease,
      sessionId: ready?.sessionId ?? snapshot.sessionId,
      sequence,
      ready,
      type: payload.t,
      data: payload.d,
      nowMs: options.now(),
    });
    if (!active || !hasLease(currentLease)) return;
    snapshot.lastSequence = sequence;
    if (ready) {
      snapshot.sessionId = ready.sessionId;
      snapshot.resumeGatewayUrl = ready.resumeGatewayUrl;
    }
    if (ready || payload.t === "RESUMED") {
      snapshot.status = "ready";
      snapshot.backoffAttempt = 0;
      snapshot.lastError = null;
      await requirePersist();
    }
  }

  async function handleHello(data: unknown): Promise<void> {
    if (!isRecord(data) || !isPositiveInteger(data.heartbeat_interval) || !socket) return;
    const currentSocket = socket;
    const currentLease = lease;
    snapshot.heartbeatIntervalMs = data.heartbeat_interval;
    heartbeatAwaitingAck = false;
    let handshake: string;
    if (canResume(snapshot)) {
      handshake = JSON.stringify(
        buildResumePayload(options.config.token, snapshot.sessionId!, snapshot.lastSequence!),
      );
      snapshot.status = "resuming";
    } else {
      handshake = JSON.stringify(buildIdentifyPayload(options.config.token, "linux"));
      snapshot.status = "connecting";
    }
    await requirePersist();
    if (
      !active ||
      !currentLease ||
      !hasLease(currentLease) ||
      socket !== currentSocket ||
      currentSocket.readyState !== GATEWAY_SOCKET_OPEN
    ) {
      return;
    }
    currentSocket.send(handshake);
    scheduleHeartbeat(Math.floor(data.heartbeat_interval * clampRandom(options.random())));
  }

  function scheduleHeartbeat(delayMs: number): void {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    const currentSocket = socket;
    const currentLease = lease;
    heartbeatTimer = setTimeout(
      () => {
        if (!active || !currentLease || !hasLease(currentLease) || socket !== currentSocket) return;
        void sendHeartbeat(false).catch((error) => loseLeadership(error, currentLease));
      },
      Math.max(1, delayMs),
    );
    heartbeatTimer.unref?.();
  }

  async function sendHeartbeat(forced: boolean): Promise<void> {
    if (!socket || socket.readyState !== GATEWAY_SOCKET_OPEN || !snapshot.heartbeatIntervalMs)
      return;
    const currentSocket = socket;
    const currentLease = lease;
    if (heartbeatAwaitingAck && !forced) {
      reconnectImmediately("Gateway heartbeat ACK was not received.");
      return;
    }
    await requirePersist({ lastHeartbeatAtMs: options.now() });
    if (
      !active ||
      !currentLease ||
      !hasLease(currentLease) ||
      socket !== currentSocket ||
      currentSocket.readyState !== GATEWAY_SOCKET_OPEN
    ) {
      return;
    }
    currentSocket.send(JSON.stringify(buildHeartbeatPayload(receivedSequence)));
    heartbeatAwaitingAck = true;
    scheduleHeartbeat(snapshot.heartbeatIntervalMs);
  }

  function reconnectImmediately(error = "Gateway requested reconnect."): void {
    const currentLease = lease;
    snapshot.lastError = error;
    nextReconnectAtMs = options.now();
    const current = socket;
    socket = null;
    clearHeartbeat();
    current?.terminate();
    void requirePersist().catch((error) => {
      if (currentLease) loseLeadership(error, currentLease);
    });
  }

  async function reconnectWithBackoff(error: string): Promise<void> {
    const current = socket;
    socket = null;
    clearHeartbeat();
    current?.terminate();
    await enterBackoff(error);
  }

  async function enterBackoff(error: string): Promise<void> {
    if (!active || !lease) return;
    snapshot.lastError = error;
    snapshot.status = "backoff";
    nextReconnectAtMs = options.now() + nextBackoffMillis(snapshot.backoffAttempt);
    snapshot.backoffAttempt += 1;
    await requirePersist();
  }

  function loseLeadership(error: unknown, expectedLease?: PostgresLease): void {
    if (expectedLease && !hasLease(expectedLease)) return;
    if (lease || socket) options.onError?.(error, { identityId: options.config.identityId });
    lease = null;
    const current = socket;
    socket = null;
    clearHeartbeat();
    current?.terminate();
    heartbeatAwaitingAck = false;
  }

  async function requirePersist(
    input: {
      lastHeartbeatAtMs?: number;
      lastHeartbeatAckAtMs?: number;
    } = {},
  ): Promise<void> {
    if (!(await persist(input))) throw new Error("Gateway state write was fenced.");
  }

  async function persist(
    input: {
      lastHeartbeatAtMs?: number;
      lastHeartbeatAckAtMs?: number;
    } = {},
  ): Promise<boolean> {
    if (!lease) return false;
    return options.store.write(options.config.identityId, lease, snapshot, {
      nowMs: options.now(),
      ...input,
    });
  }

  async function clearResumeState(): Promise<void> {
    if (!lease) throw new Error("Gateway reset has no lease.");
    const currentLease = lease;
    await options.store.clearResumeState(options.config.identityId, currentLease, options.now());
    if (!active || !hasLease(currentLease)) return;
    snapshot.sessionId = null;
    snapshot.resumeGatewayUrl = null;
    snapshot.lastSequence = null;
    receivedSequence = null;
  }

  function hasLease(expected: PostgresLease): boolean {
    return (
      lease?.leaseToken === expected.leaseToken &&
      lease.fencingGeneration === expected.fencingGeneration
    );
  }

  function clearHeartbeat(): void {
    if (heartbeatTimer) clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
    heartbeatAwaitingAck = false;
  }
}

interface GatewayEnvelope {
  op: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

function emptySnapshot(): GatewaySnapshot {
  return {
    status: "idle",
    sessionId: null,
    resumeGatewayUrl: null,
    lastSequence: null,
    backoffAttempt: 0,
    lastError: null,
    heartbeatIntervalMs: null,
  };
}

function copyGatewaySnapshot(value: GatewaySnapshot): GatewaySnapshot {
  return {
    status: value.status,
    sessionId: value.sessionId,
    resumeGatewayUrl: value.resumeGatewayUrl,
    lastSequence: value.lastSequence,
    backoffAttempt: value.backoffAttempt,
    lastError: value.lastError,
    heartbeatIntervalMs: value.heartbeatIntervalMs,
  };
}

function canResume(snapshot: GatewaySnapshot): boolean {
  return (
    snapshot.sessionId !== null &&
    snapshot.resumeGatewayUrl !== null &&
    snapshot.lastSequence !== null
  );
}

function appendGatewayParameters(value: string): string {
  const url = new URL(value);
  url.searchParams.set("v", "10");
  url.searchParams.set("encoding", "json");
  return url.toString();
}

function isReadyPayload(value: unknown): value is {
  session_id: string;
  resume_gateway_url: string;
} {
  return (
    isRecord(value) &&
    typeof value.session_id === "string" &&
    typeof value.resume_gateway_url === "string"
  );
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function clampRandom(random: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(random) ? random : 0.5));
}

function readDuration(value: number, name: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < 100 || value > maximum) {
    throw new Error(`${name} must be between 100 and ${maximum} milliseconds.`);
  }
  return value;
}

function validateIdentity(identity: GatewayIdentityConfig): void {
  if (!/^(standard|white-label:[A-Za-z0-9_-]{1,128})$/.test(identity.identityId)) {
    throw new Error(`Invalid Gateway identity: ${identity.identityId}.`);
  }
  if (!identity.botUserId || !identity.token) {
    throw new Error(`Gateway identity ${identity.identityId} is missing credentials.`);
  }
}
