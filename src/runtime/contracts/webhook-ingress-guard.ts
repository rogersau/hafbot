export interface GuardPolicyInput {
  requestsPerMinute: number;
  burst: number;
  concurrency: number;
  leaseTimeoutMs: number;
  duplicateWindowMs: number;
}

export interface GuardSnapshot {
  activeLeases: number;
  tokens: number | null;
  updatedAtMs: number | null;
  outcomes: Record<string, number>;
  sampledAtMs: number;
}

export type GuardReserveResult =
  | { ok: true; leaseId: string; expiresAtMs: number }
  | {
      ok: false;
      reason: "rate_limited" | "concurrency_limited";
      retryAfterSeconds: number;
    };

export interface WebhookIngressGuardScope {
  reserve(input: { nowMs: number; policy: GuardPolicyInput }): Promise<GuardReserveResult>;
  registerBody(input: {
    leaseId: string;
    sha256: string;
    nowMs: number;
    duplicateWindowMs: number;
  }): Promise<{ ok: true } | { ok: false; reason: "duplicate" | "lease_expired" }>;
  complete(input: {
    leaseId: string;
    outcome: string;
    nowMs: number;
    sha256?: string;
    retryable?: boolean;
  }): Promise<void>;
  snapshot(nowMs?: number): Promise<GuardSnapshot>;
}

export interface WebhookIngressGuardNamespace {
  getByName(name: string): WebhookIngressGuardScope;
}
