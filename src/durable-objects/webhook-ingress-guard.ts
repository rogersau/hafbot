import { DurableObject } from "cloudflare:workers";

import type {
  GuardPolicyInput,
  GuardReserveResult,
  GuardSnapshot,
} from "../runtime/contracts/webhook-ingress-guard";

export type {
  GuardPolicyInput,
  GuardReserveResult,
  GuardSnapshot,
} from "../runtime/contracts/webhook-ingress-guard";

interface WebhookIngressGuardEnv {}

export class WebhookIngressGuardDO extends DurableObject<WebhookIngressGuardEnv> {
  constructor(ctx: DurableObjectState, env: WebhookIngressGuardEnv) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS bucket (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), tokens REAL NOT NULL, updated_at_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS leases (lease_id TEXT PRIMARY KEY, expires_at_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS duplicates (sha256 TEXT PRIMARY KEY, expires_at_ms INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS counters (bucket_ms INTEGER NOT NULL, outcome TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(bucket_ms, outcome));
      `);
    });
  }

  async reserve(input: { nowMs: number; policy: GuardPolicyInput }): Promise<GuardReserveResult> {
    this.prune(input.nowMs);
    const active = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) count FROM leases")
      .one().count;
    if (active >= input.policy.concurrency) {
      this.count(input.nowMs, "concurrency_limited");
      return { ok: false, reason: "concurrency_limited", retryAfterSeconds: 1 };
    }
    const existing = this.ctx.storage.sql
      .exec<{ tokens: number; updated_at_ms: number }>(
        "SELECT tokens, updated_at_ms FROM bucket WHERE singleton = 1",
      )
      .toArray()[0];
    const elapsed = Math.max(0, input.nowMs - (existing?.updated_at_ms ?? input.nowMs));
    const tokens = Math.min(
      input.policy.burst,
      (existing?.tokens ?? input.policy.burst) +
        (elapsed * input.policy.requestsPerMinute) / 60_000,
    );
    if (tokens < 1) {
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil(((1 - tokens) * 60) / input.policy.requestsPerMinute),
      );
      this.count(input.nowMs, "rate_limited");
      return { ok: false, reason: "rate_limited", retryAfterSeconds };
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO bucket(singleton, tokens, updated_at_ms) VALUES(1, ?, ?) ON CONFLICT(singleton) DO UPDATE SET tokens=excluded.tokens, updated_at_ms=excluded.updated_at_ms",
      tokens - 1,
      input.nowMs,
    );
    const leaseId = crypto.randomUUID();
    const expiresAtMs = input.nowMs + input.policy.leaseTimeoutMs;
    this.ctx.storage.sql.exec(
      "INSERT INTO leases(lease_id, expires_at_ms) VALUES(?, ?)",
      leaseId,
      expiresAtMs,
    );
    this.count(input.nowMs, "reserved");
    return { ok: true, leaseId, expiresAtMs };
  }

  async registerBody(input: {
    leaseId: string;
    sha256: string;
    nowMs: number;
    duplicateWindowMs: number;
  }): Promise<{ ok: true } | { ok: false; reason: "duplicate" | "lease_expired" }> {
    this.prune(input.nowMs);
    const lease = this.ctx.storage.sql
      .exec("SELECT lease_id FROM leases WHERE lease_id = ?", input.leaseId)
      .toArray()[0];
    if (!lease) return { ok: false, reason: "lease_expired" };
    const duplicate = this.ctx.storage.sql
      .exec("SELECT sha256 FROM duplicates WHERE sha256 = ?", input.sha256)
      .toArray()[0];
    if (duplicate) {
      this.count(input.nowMs, "duplicate");
      return { ok: false, reason: "duplicate" };
    }
    this.ctx.storage.sql.exec(
      "INSERT INTO duplicates(sha256, expires_at_ms) VALUES(?, ?)",
      input.sha256,
      input.nowMs + input.duplicateWindowMs,
    );
    return { ok: true };
  }

  async complete(input: {
    leaseId: string;
    outcome: string;
    nowMs: number;
    sha256?: string;
    retryable?: boolean;
  }): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE lease_id = ?", input.leaseId);
    if (input.retryable && input.sha256)
      this.ctx.storage.sql.exec("DELETE FROM duplicates WHERE sha256 = ?", input.sha256);
    this.count(input.nowMs, input.outcome);
  }

  async snapshot(nowMs = Date.now()): Promise<GuardSnapshot> {
    this.prune(nowMs);
    const activeLeases = this.ctx.storage.sql
      .exec<{ count: number }>("SELECT COUNT(*) count FROM leases")
      .one().count;
    const bucket = this.ctx.storage.sql
      .exec<{ tokens: number; updated_at_ms: number }>(
        "SELECT tokens, updated_at_ms FROM bucket WHERE singleton = 1",
      )
      .toArray()[0];
    const outcomes = Object.fromEntries(
      this.ctx.storage.sql
        .exec<{ outcome: string; count: number }>(
          "SELECT outcome, SUM(count) count FROM counters WHERE bucket_ms >= ? GROUP BY outcome",
          nowMs - 86_400_000,
        )
        .toArray()
        .map((row) => [row.outcome, row.count]),
    );
    return {
      activeLeases,
      tokens: bucket?.tokens ?? null,
      updatedAtMs: bucket?.updated_at_ms ?? null,
      outcomes,
      sampledAtMs: nowMs,
    };
  }

  private prune(nowMs: number): void {
    this.ctx.storage.sql.exec("DELETE FROM leases WHERE expires_at_ms <= ?", nowMs);
    this.ctx.storage.sql.exec("DELETE FROM duplicates WHERE expires_at_ms <= ?", nowMs);
    this.ctx.storage.sql.exec("DELETE FROM counters WHERE bucket_ms < ?", nowMs - 86_400_000);
  }

  private count(nowMs: number, outcome: string): void {
    const bucketMs = Math.floor(nowMs / 300_000) * 300_000;
    this.ctx.storage.sql.exec(
      "INSERT INTO counters(bucket_ms, outcome, count) VALUES(?, ?, 1) ON CONFLICT(bucket_ms, outcome) DO UPDATE SET count=count+1",
      bucketMs,
      outcome,
    );
  }
}
