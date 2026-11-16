import type { Env as ApplicationEnv } from "../../src/env";
import type { WebhookIngressGuardNamespace } from "../../src/runtime/contracts/webhook-ingress-guard";

/** Extra inputs used only by the SQLite application fixture. */
export interface Env extends ApplicationEnv {
  HAF_DB: D1Database;
  GATEWAY_ENABLED?: string;
  GATEWAY_SESSION_DO: DurableObjectNamespace;
  WEBHOOK_INGRESS_GUARD_DO?: WebhookIngressGuardNamespace;
  TICKET_TRANSCRIPTS_BUCKET?: R2Bucket;
  STEAM_BAN_LOOKUP_KV?: KVNamespace;
  PLAYER_COUNT_STREAK_REPORTED_KV?: KVNamespace;
  WORKER_VERSION?: { id: string; tag?: string; timestamp?: string };
}
