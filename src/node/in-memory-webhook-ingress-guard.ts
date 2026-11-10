import { randomUUID } from "node:crypto";

import type {
  GuardPolicyInput,
  GuardSnapshot,
  WebhookIngressGuardNamespace,
  WebhookIngressGuardScope,
} from "../runtime/contracts/webhook-ingress-guard";

interface MemoryScopeState {
  tokens: number | null;
  updatedAtMs: number | null;
  leases: Map<string, number>;
  outcomes: Map<string, number>;
}

export function createInMemoryWebhookIngressGuard(
  options: { maxScopes?: number; randomId?: () => string } = {},
): WebhookIngressGuardNamespace {
  const maxScopes = readPositiveInteger(options.maxScopes ?? 10_000, "maxScopes");
  const randomId = options.randomId ?? randomUUID;
  const scopes = new Map<string, MemoryScopeState>();
  const overflow = createState();

  return {
    getByName(name) {
      let state = scopes.get(name);
      if (!state) {
        if (scopes.size >= maxScopes) return createScope(overflow, randomId);
        state = createState();
        scopes.set(name, state);
      } else {
        scopes.delete(name);
        scopes.set(name, state);
      }
      return createScope(state, randomId);
    },
  };
}

function createState(): MemoryScopeState {
  return {
    tokens: null,
    updatedAtMs: null,
    leases: new Map(),
    outcomes: new Map(),
  };
}

function createScope(state: MemoryScopeState, randomId: () => string): WebhookIngressGuardScope {
  return {
    async reserve({ nowMs, policy }) {
      validatePolicy(policy);
      pruneLeases(state, nowMs);
      if (state.leases.size >= policy.concurrency) {
        count(state, "concurrency_limited");
        return { ok: false, reason: "concurrency_limited", retryAfterSeconds: 1 };
      }
      const elapsed = Math.max(0, nowMs - (state.updatedAtMs ?? nowMs));
      const tokens = Math.min(
        policy.burst,
        (state.tokens ?? policy.burst) + (elapsed * policy.requestsPerMinute) / 60_000,
      );
      state.tokens = tokens;
      state.updatedAtMs = nowMs;
      if (tokens < 1) {
        count(state, "rate_limited");
        return {
          ok: false,
          reason: "rate_limited",
          retryAfterSeconds: Math.max(1, Math.ceil(((1 - tokens) * 60) / policy.requestsPerMinute)),
        };
      }
      state.tokens = tokens - 1;
      const leaseId = randomId();
      const expiresAtMs = nowMs + policy.leaseTimeoutMs;
      state.leases.set(leaseId, expiresAtMs);
      count(state, "reserved");
      return { ok: true, leaseId, expiresAtMs };
    },

    async registerBody({ leaseId, nowMs }) {
      pruneLeases(state, nowMs);
      return state.leases.has(leaseId) ? { ok: true } : { ok: false, reason: "lease_expired" };
    },

    async complete({ leaseId, outcome }) {
      state.leases.delete(leaseId);
      count(state, normalizeOutcome(outcome));
    },

    async snapshot(nowMs = Date.now()): Promise<GuardSnapshot> {
      pruneLeases(state, nowMs);
      return {
        activeLeases: state.leases.size,
        tokens: state.tokens,
        updatedAtMs: state.updatedAtMs,
        outcomes: Object.fromEntries(state.outcomes),
        sampledAtMs: nowMs,
      };
    },
  };
}

function pruneLeases(state: MemoryScopeState, nowMs: number): void {
  for (const [leaseId, expiresAtMs] of state.leases) {
    if (expiresAtMs <= nowMs) state.leases.delete(leaseId);
  }
}

function count(state: MemoryScopeState, outcome: string): void {
  state.outcomes.set(outcome, (state.outcomes.get(outcome) ?? 0) + 1);
}

function validatePolicy(policy: GuardPolicyInput): void {
  readPositiveInteger(policy.requestsPerMinute, "requestsPerMinute");
  readPositiveInteger(policy.burst, "burst");
  readPositiveInteger(policy.concurrency, "concurrency");
  readPositiveInteger(policy.leaseTimeoutMs, "leaseTimeoutMs");
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive.`);
  return value;
}

function normalizeOutcome(value: string): string {
  return /^[a-z0-9][a-z0-9_.-]{0,63}$/.test(value) ? value : "invalid_outcome";
}
