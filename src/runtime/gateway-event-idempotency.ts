export type GatewayEventOperationClaim =
  | { status: "acquired" | "reclaimed"; leaseToken: string; attempts: number }
  | { status: "busy"; leaseExpiresAtMs: number }
  | {
      status: "completed" | "terminal";
      outcomeCode: string | null;
      outcomeJson: string | null;
    };

export interface GatewayEventOperationReceipt {
  eventKey: string;
  handlerKey: string;
  state: "processing" | "completed" | "terminal";
  leaseExpiresAtMs: number | null;
  attempts: number;
  outcomeCode: string | null;
  outcomeJson: string | null;
  completedAtMs: number | null;
}

export interface GatewayEventOperationStore {
  claim(
    eventKey: string,
    handlerKey: string,
    nowMs: number,
    leaseDurationMs: number,
  ): Promise<GatewayEventOperationClaim>;
  complete(
    leaseToken: string,
    eventKey: string,
    handlerKey: string,
    nowMs: number,
    outcomeCode: string,
    outcomeJson?: string | null,
  ): Promise<boolean>;
  terminal(
    leaseToken: string,
    eventKey: string,
    handlerKey: string,
    nowMs: number,
    outcomeCode: string,
  ): Promise<boolean>;
  renew(
    leaseToken: string,
    eventKey: string,
    handlerKey: string,
    nowMs: number,
    leaseDurationMs: number,
  ): Promise<boolean>;
  read(eventKey: string, handlerKey: string): Promise<GatewayEventOperationReceipt | null>;
  cleanupCompletedBefore(cutoffMs: number): Promise<number>;
}

export interface GatewayEventIdempotencyEvent {
  event: "duplicate_suppressed" | "lease_reclaimed";
  eventKey: string;
  handlerKey: string;
  attempts: number;
}

export interface GatewayEventOperationRunner {
  run(handlerKey: string, operation: () => Promise<unknown>): Promise<boolean>;
  runResult<T>(handlerKey: string, operation: () => Promise<T>): Promise<T>;
  hasStarted(handlerKey: string): Promise<boolean>;
}

export function createGatewayEventOperationRunner(input: {
  eventKey: string;
  store: GatewayEventOperationStore;
  nowMs?: () => number;
  leaseDurationMs?: number;
  emit?: (event: GatewayEventIdempotencyEvent) => void;
}): GatewayEventOperationRunner {
  const nowMs = input.nowMs ?? Date.now;
  const leaseDurationMs = Math.max(
    1,
    Math.floor(input.leaseDurationMs ?? GATEWAY_EVENT_OPERATION_LEASE_MS),
  );
  return {
    async hasStarted(handlerKey) {
      return (await input.store.read(input.eventKey, handlerKey)) !== null;
    },
    async run(handlerKey, operation) {
      const result = await runClaimedOperation(handlerKey, operation, false);
      return result.executed;
    },
    async runResult<T>(handlerKey: string, operation: () => Promise<T>): Promise<T> {
      const result = await runClaimedOperation(handlerKey, operation, true);
      return result.value as T;
    },
  };

  async function runClaimedOperation<T>(
    handlerKey: string,
    operation: () => Promise<T>,
    persistResult: boolean,
  ): Promise<{ executed: boolean; value?: T }> {
    const claimedAtMs = nowMs();
    const claim = await input.store.claim(input.eventKey, handlerKey, claimedAtMs, leaseDurationMs);
    if (claim.status === "terminal") {
      throw new QueueTerminalError(claim.outcomeCode ?? "gateway_operation_terminal");
    }
    if (claim.status === "completed") {
      safeEmit(input.emit, {
        event: "duplicate_suppressed",
        eventKey: input.eventKey,
        handlerKey,
        attempts: 0,
      });
      if (persistResult) {
        if (claim.outcomeJson === null) {
          throw new QueueRetryableError("gateway_operation_result_missing", 1);
        }
        return { executed: false, value: JSON.parse(claim.outcomeJson) as T };
      }
      return { executed: false };
    }
    if (claim.status === "busy") {
      throw new QueueRetryableError(
        "gateway_operation_busy",
        Math.max(1, Math.ceil((claim.leaseExpiresAtMs - claimedAtMs) / 1_000)),
      );
    }
    if (claim.status === "reclaimed") {
      safeEmit(input.emit, {
        event: "lease_reclaimed",
        eventKey: input.eventKey,
        handlerKey,
        attempts: claim.attempts,
      });
    }
    if (claim.status !== "acquired" && claim.status !== "reclaimed") {
      throw new QueueRetryableError("gateway_operation_claim_invalid", 1);
    }

    let leaseLost = false;
    let leaseExpiresAtMs = claimedAtMs + leaseDurationMs;
    let renewal = Promise.resolve();
    const heartbeat = setInterval(
      () => {
        renewal = renewal
          .then(async () => {
            const renewedAtMs = nowMs();
            // A renewal can commit even if its response is lost.
            leaseExpiresAtMs = renewedAtMs + leaseDurationMs;
            const renewed = await input.store.renew(
              claim.leaseToken,
              input.eventKey,
              handlerKey,
              renewedAtMs,
              leaseDurationMs,
            );
            if (!renewed) leaseLost = true;
          })
          .catch(() => {
            leaseLost = true;
          });
      },
      Math.max(10, Math.floor(leaseDurationMs / 3)),
    );
    try {
      let value: T;
      try {
        value = await operation();
      } finally {
        clearInterval(heartbeat);
        await renewal;
      }

      if (leaseLost) throw new QueueRetryableError("gateway_operation_lease_lost", 1);

      const completed = await input.store.complete(
        claim.leaseToken,
        input.eventKey,
        handlerKey,
        nowMs(),
        "completed",
        persistResult ? JSON.stringify(value) : null,
      );
      if (!completed) throw new QueueRetryableError("gateway_operation_lease_lost", 1);
      return { executed: true, value };
    } catch (error) {
      if (error instanceof QueueTerminalError) {
        await input.store.terminal(
          claim.leaseToken,
          input.eventKey,
          handlerKey,
          nowMs(),
          error.reasonCode,
        );
      }
      const outcome = classifyQueueDeliveryError(error);
      if (outcome.status === "retry") {
        // Keep the receipt leased after an ambiguous failure, but do not spend
        // another delivery attempt waiting for our own retained lease.
        const retry = new QueueRetryableError(
          outcome.reasonCode,
          Math.max(1, outcome.delaySeconds ?? 0, Math.ceil((leaseExpiresAtMs - nowMs()) / 1_000)),
        );
        retry.cause = error;
        throw retry;
      }
      throw error;
    }
  }
}

export function deriveGatewayEventKey(value: unknown): string {
  const record = isRecord(value) ? value : {};
  const identity = typeof record.botIdentityId === "string" ? record.botIdentityId : "standard";
  const type = typeof record.type === "string" ? record.type : "unknown";
  const sessionId = typeof record.sessionId === "string" ? record.sessionId : null;
  const sequence = record.sequence;
  if (
    isSafeKeyPart(identity, 128) &&
    isSafeKeyPart(type, 64) &&
    sessionId !== null &&
    isSafeKeyPart(sessionId, 128) &&
    typeof sequence === "number" &&
    Number.isSafeInteger(sequence) &&
    sequence >= 0
  ) {
    return `v2:${identity}:${type}:${sessionId}:${sequence}`;
  }
  return `v2:${safeKeyPart(identity)}:${safeKeyPart(type)}:${sha256Hex(
    canonicalJson(gatewayEventIdentity(record)),
  )}`;
}

export function deriveGatewayOperationNonce(eventKey: string, handlerKey: string): string {
  return `g:${base64Url(sha256Bytes(`${eventKey}\0${handlerKey}`).slice(0, 16))}`;
}

export function isValidGatewayEventKey(value: string): boolean {
  return (
    value.length <= 400 &&
    (/^v2:[A-Za-z0-9_.:-]{1,128}:[A-Za-z0-9_.:-]{1,64}:[A-Za-z0-9_.:-]{1,128}:\d{1,16}$/.test(
      value,
    ) ||
      /^v2:[A-Za-z0-9_.:-]{1,128}:[A-Za-z0-9_.:-]{1,64}:[a-f0-9]{64}$/.test(value))
  );
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? "null";
  return `{${Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function gatewayEventIdentity(record: Record<string, unknown>): Record<string, unknown> {
  return {
    version: record.version,
    botIdentityId: record.botIdentityId,
    sessionId: record.sessionId,
    sequence: record.sequence,
    type: record.type,
    data: record.data,
  };
}

function safeKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_.:-]/g, "_").slice(0, 128);
}

function isSafeKeyPart(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && /^[A-Za-z0-9_.:-]+$/.test(value);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function sha256Hex(value: string): string {
  return Array.from(sha256Bytes(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sha256Bytes(value: string): Uint8Array {
  const input = new TextEncoder().encode(value);
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const bitLength = BigInt(input.length) * 8n;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffffffffn));
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn));

  const state = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < bytes.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4);
    }
    for (let index = 16; index < 64; index += 1) {
      const a = words[index - 15]!;
      const b = words[index - 2]!;
      const s0 = rotateRight(a, 7) ^ rotateRight(a, 18) ^ (a >>> 3);
      const s1 = rotateRight(b, 17) ^ rotateRight(b, 19) ^ (b >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choice = (e! & f!) ^ (~e! & g!);
      const temp1 = (h! + sum1 + choice + SHA256_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }
  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  state.forEach((word, index) => outputView.setUint32(index * 4, word));
  return output;
}

function rotateRight(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function safeEmit(
  emit: ((event: GatewayEventIdempotencyEvent) => void) | undefined,
  event: GatewayEventIdempotencyEvent,
): void {
  try {
    emit?.(event);
  } catch {
    // Observability must not change idempotency behavior.
  }
}
import { isRecord } from "../unknown-parse";
import {
  classifyQueueDeliveryError,
  QueueRetryableError,
  QueueTerminalError,
} from "./queue-delivery";

export const GATEWAY_EVENT_OPERATION_LEASE_MS = 2 * 60 * 1_000;
export const GATEWAY_EVENT_RECEIPT_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;
