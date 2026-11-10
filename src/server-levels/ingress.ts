import { z } from "zod";
import type { ServerLevelStore } from "../runtime/contracts/server-level-store";
import type { WebhookIngressGuardNamespace } from "../runtime/contracts/webhook-ingress-guard";
import type { ServerLevelCredentialService } from "./credentials";
import {
  isServerLevelWebhookEventType,
  normalizeServerLevelWebhookEvent,
  type ConfiguredGameServer,
  type ServerLevelProviderEventType,
} from "./model";
import { SERVER_LEVEL_ORDERING_WINDOW_MS } from "./policy";
import { emitServerLevelTelemetry, type ServerLevelTelemetryEmitter } from "./telemetry";

export const SERVER_LEVEL_INGRESS_MAX_BODY_BYTES = 64 * 1_024;

export interface ServerLevelIngressMessage {
  inboxId: string;
  guildId: string;
}

export interface ServerLevelQueueSender {
  send(message: ServerLevelIngressMessage, options?: { delaySeconds?: number }): Promise<unknown>;
}

export interface ServerLevelIngressOptions {
  store: ServerLevelStore;
  credentials: ServerLevelCredentialService;
  queue?: ServerLevelQueueSender;
  now?: () => number;
  createId?: () => string;
  admissionGuard?: WebhookIngressGuardNamespace;
  onWebhookVerified?: (server: ConfiguredGameServer) => Promise<void>;
  emitTelemetry?: ServerLevelTelemetryEmitter;
}

const canonicalBodySchema = z
  .object({
    version: z.literal(1),
    providerServerId: z.string().trim().min(1).max(200),
    occurredAtMs: z.number().int().nonnegative(),
    steamId64: z
      .string()
      .regex(/^7656119\d{10}$/)
      .nullable()
      .optional(),
    population: z.number().int().nonnegative().max(100_000).nullable().optional(),
    queueSize: z.number().int().nonnegative().max(100_000).nullable().optional(),
  })
  .strict();

const hephaistosBodySchema = z
  .object({
    player_steam64: z.union([z.string(), z.number()]).nullable().optional(),
    occurredAtMs: z.number().int().nonnegative().optional(),
    population: z.number().int().nonnegative().max(100_000).nullable().optional(),
    players: z.number().int().nonnegative().max(100_000).nullable().optional(),
    queueSize: z.number().int().nonnegative().max(100_000).nullable().optional(),
    queue_size: z.number().int().nonnegative().max(100_000).nullable().optional(),
    providerServerId: z.string().trim().min(1).max(200).optional(),
    server_id: z.string().trim().min(1).max(200).optional(),
  })
  .passthrough();

export async function handleServerLevelIngress(
  request: Request,
  endpointId: string,
  options: ServerLevelIngressOptions,
): Promise<Response> {
  const startedAtMs = options.now?.() ?? Date.now();
  const admission = options.admissionGuard
    ? await reserveServerLevelAdmission(
        options.admissionGuard,
        endpointId,
        options.now?.() ?? Date.now(),
      )
    : null;
  if (admission && !admission.ok) {
    return emptyResponse(
      admission.status,
      admission.retryAfterSeconds ? { "retry-after": String(admission.retryAfterSeconds) } : {},
    );
  }
  let response: Response;
  try {
    response = await handleAdmittedServerLevelIngress(request, endpointId, options);
  } catch (error) {
    emitServerLevelTelemetry(options.emitTelemetry, {
      category: "ingress",
      outcome: "failed",
      durationMs: (options.now?.() ?? Date.now()) - startedAtMs,
      reasonCode: "unhandled_error",
    });
    await admission?.complete("failed");
    throw error;
  }
  if (response.status !== 204) {
    emitServerLevelTelemetry(options.emitTelemetry, {
      category: "ingress",
      outcome: "rejected",
      durationMs: (options.now?.() ?? Date.now()) - startedAtMs,
      statusCode: response.status,
      reasonCode: `http_${response.status}`,
    });
  }
  await admission?.complete(response.status === 204 ? "accepted" : `rejected_${response.status}`);
  return response;
}

async function handleAdmittedServerLevelIngress(
  request: Request,
  endpointId: string,
  options: ServerLevelIngressOptions,
): Promise<Response> {
  if (request.method !== "POST") return emptyResponse(405, { allow: "POST" });
  const server = await options.store.readConfiguredGameServerByEndpoint(endpointId);
  if (!server) return emptyResponse(404);
  const technicalHeaders = readTechnicalHeaders(request.headers);
  if (!technicalHeaders) return emptyResponse(400);
  if (technicalHeaders.eventType === "verification") {
    emitServerLevelTelemetry(options.emitTelemetry, {
      category: "ingress",
      outcome: "verification",
      durationMs: 0,
    });
    return emptyResponse(204);
  }
  if (!isJsonContentType(request.headers.get("content-type"))) return emptyResponse(415);
  const declaredLength = parseContentLength(request.headers.get("content-length"));
  if (declaredLength === "invalid") return emptyResponse(400);
  if (declaredLength !== null && declaredLength > SERVER_LEVEL_INGRESS_MAX_BODY_BYTES) {
    return emptyResponse(413);
  }
  const exactBody = await readBoundedBody(request, SERVER_LEVEL_INGRESS_MAX_BODY_BYTES);
  if (!exactBody.ok) return emptyResponse(exactBody.reason === "too_large" ? 413 : 400);
  if (
    !(await options.credentials.verifyHephaistosSignature({
      credentialId: server.webhookCredentialId,
      guildId: server.guildId,
      configuredGameServerId: server.id,
      deliveryId: technicalHeaders.deliveryId,
      suppliedSignature: technicalHeaders.signature,
    }))
  ) {
    return emptyResponse(401);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(exactBody.value);
  } catch {
    return emptyResponse(400);
  }
  const now = options.now?.() ?? Date.now();
  if (!isServerLevelWebhookEventType(technicalHeaders.eventType)) return emptyResponse(422);
  if (!server.subscribedEvents.includes(technicalHeaders.eventType)) return emptyResponse(422);
  const eventType = normalizeServerLevelWebhookEvent(technicalHeaders.eventType);
  const fact = parseHephaistosFact(parsedJson, exactBody.value, eventType, server, now);
  if (!fact) return emptyResponse(400);
  const bodySha256 = await sha256Hex(exactBody.value);
  const accepted = await options.store.acceptProviderEvent({
    inboxId: options.createId?.() ?? crypto.randomUUID(),
    deliveryId: technicalHeaders.deliveryId,
    configuredGameServerId: server.id,
    guildId: server.guildId,
    eventType,
    occurredAtMs: fact.occurredAtMs,
    steamId64: fact.steamId64,
    population: fact.population,
    queueSize: fact.queueSize,
    receivedAtMs: now,
    bodySha256,
  });
  if (!accepted.duplicateBodyMatches) return emptyResponse(409);
  emitServerLevelTelemetry(options.emitTelemetry, {
    category: "ingress",
    outcome: accepted.accepted ? "accepted" : "duplicate",
    durationMs: 0,
  });

  if (server.webhookVerifiedAtMs === null) {
    const verifiedServer = {
      ...server,
      webhookVerifiedAtMs: now,
      updatedAtMs: now,
    };
    await options.store.updateConfiguredGameServer(verifiedServer);
    await options.onWebhookVerified?.(verifiedServer).catch(() => undefined);
  }

  if (accepted.accepted && options.queue) {
    try {
      await options.queue.send(
        { inboxId: accepted.inboxId, guildId: server.guildId },
        { delaySeconds: Math.ceil(SERVER_LEVEL_ORDERING_WINDOW_MS / 1_000) },
      );
      await options.store.markIngressPublished(accepted.inboxId, now);
    } catch {
      // Durable outbox state remains pending for the scheduled repair sweep.
    }
  }
  return emptyResponse(204);
}

async function reserveServerLevelAdmission(
  guard: WebhookIngressGuardNamespace,
  endpointId: string,
  nowMs: number,
): Promise<
  | { ok: true; complete(outcome: string): Promise<void> }
  | { ok: false; status: 429 | 503; retryAfterSeconds?: number }
> {
  const policy = {
    requestsPerMinute: 120,
    burst: 30,
    concurrency: 10,
    leaseTimeoutMs: 30_000,
    duplicateWindowMs: 0,
  };
  const source = guard.getByName(`source:v1:server-levels:${endpointId}`);
  const global = guard.getByName("global:v1:server-levels");
  try {
    const sourceReservation = await source.reserve({ nowMs, policy });
    if (!sourceReservation.ok) {
      return {
        ok: false,
        status: 429,
        retryAfterSeconds: sourceReservation.retryAfterSeconds,
      };
    }
    const globalReservation = await global.reserve({
      nowMs,
      policy: { ...policy, requestsPerMinute: 2_000, burst: 200, concurrency: 100 },
    });
    if (!globalReservation.ok) {
      await source.complete({
        leaseId: sourceReservation.leaseId,
        outcome: "global_limited",
        nowMs,
      });
      return {
        ok: false,
        status: 429,
        retryAfterSeconds: globalReservation.retryAfterSeconds,
      };
    }
    return {
      ok: true,
      async complete(outcome) {
        const completedAtMs = Date.now();
        await Promise.allSettled([
          source.complete({ leaseId: sourceReservation.leaseId, outcome, nowMs: completedAtMs }),
          global.complete({ leaseId: globalReservation.leaseId, outcome, nowMs: completedAtMs }),
        ]);
      },
    };
  } catch {
    return { ok: false, status: 503 };
  }
}

export async function sweepServerLevelIngressOutbox(input: {
  store: ServerLevelStore;
  queue: ServerLevelQueueSender;
  now?: () => number;
  limit?: number;
}): Promise<number> {
  const records = await input.store.listPendingIngressOutbox(input.limit ?? 100);
  let published = 0;
  for (const record of records) {
    const now = input.now?.() ?? Date.now();
    const delaySeconds = Math.max(
      0,
      Math.ceil((record.createdAtMs + SERVER_LEVEL_ORDERING_WINDOW_MS - now) / 1_000),
    );
    await input.queue.send(
      { inboxId: record.inboxId, guildId: record.guildId },
      delaySeconds > 0 ? { delaySeconds } : undefined,
    );
    await input.store.markIngressPublished(record.inboxId, now);
    published += 1;
  }
  return published;
}

function readTechnicalHeaders(headers: Headers): {
  deliveryId: string;
  eventType: string;
  signature: string;
} | null {
  if (headers.get("x-hephaistos-flavor") !== "WebHookFlavor.CFTOOLS") return null;
  const shard = headers.get("x-hephaistos-shard")?.trim();
  const deliveryId = headers.get("x-hephaistos-delivery")?.trim();
  const eventType = headers.get("x-hephaistos-event")?.trim();
  const signature = headers.get("x-hephaistos-signature")?.trim() ?? "";
  if (
    !shard ||
    !/^\d+$/.test(shard) ||
    !deliveryId ||
    !eventType ||
    deliveryId.length > 200 ||
    eventType.length > 100 ||
    (eventType !== "verification" && !/^[a-fA-F0-9]{64}$/.test(signature))
  ) {
    return null;
  }
  return { deliveryId, eventType, signature };
}

function parseHephaistosFact(
  value: unknown,
  exactBody: string,
  eventType: ServerLevelProviderEventType,
  server: ConfiguredGameServer,
  receivedAtMs: number,
): {
  occurredAtMs: number;
  steamId64: string | null;
  population: number | null;
  queueSize: number | null;
} | null {
  const canonical = canonicalBodySchema.safeParse(value);
  if (canonical.success) {
    if (canonical.data.providerServerId !== server.providerServerId) return null;
    if (
      (eventType === "player.join" || eventType === "player.leave") &&
      !canonical.data.steamId64
    ) {
      return null;
    }
    return {
      occurredAtMs: canonical.data.occurredAtMs,
      steamId64: canonical.data.steamId64 ?? null,
      population: canonical.data.population ?? null,
      queueSize: canonical.data.queueSize ?? null,
    };
  }

  const native = hephaistosBodySchema.safeParse(value);
  if (!native.success) return null;
  const bodyServerId = native.data.providerServerId ?? native.data.server_id;
  if (bodyServerId !== undefined && bodyServerId !== server.providerServerId) return null;
  const steamId64 = readSteamId64(native.data.player_steam64, exactBody);
  if ((eventType === "player.join" || eventType === "player.leave") && !steamId64) return null;
  return {
    occurredAtMs: native.data.occurredAtMs ?? receivedAtMs,
    steamId64,
    population: native.data.population ?? native.data.players ?? null,
    queueSize: native.data.queueSize ?? native.data.queue_size ?? null,
  };
}

function readSteamId64(
  value: string | number | null | undefined,
  exactBody: string,
): string | null {
  if (typeof value === "string") return /^7656119\d{10}$/.test(value) ? value : null;
  if (typeof value !== "number") return null;
  const matches = [...exactBody.matchAll(/"player_steam64"\s*:\s*(7656119\d{10})(?=\s*[,}])/g)];
  return matches.length === 1 ? (matches[0]?.[1] ?? null) : null;
}

function isJsonContentType(value: string | null): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function parseContentLength(value: string | null): number | null | "invalid" {
  if (value === null) return null;
  if (!/^\d+$/.test(value)) return "invalid";
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : "invalid";
}

async function readBoundedBody(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: string } | { ok: false; reason: "too_large" | "invalid_utf8" }> {
  if (!request.body) return { ok: true, value: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        return { ok: false, reason: "too_large" };
      }
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return {
      ok: true,
      value: new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    };
  } catch {
    return { ok: false, reason: "invalid_utf8" };
  }
}

function emptyResponse(status: number, headers?: HeadersInit): Response {
  return new Response(null, { status, headers: { "cache-control": "no-store", ...headers } });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
