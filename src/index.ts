import type { QueueBatch } from "./runtime/queue-types";
import {
  COMMERCE_GAME_QUEUE_NAME,
  handleCommerceGameQueueBatch,
} from "./runtime/commerce/game-access-runtime";
/**
 * HAF Bot - Cloudflare Worker suite
 *
 * Public entry point for health checks, admin APIs, and scheduled gateway bootstrap.
 */

import { GatewaySessionSqliteDO } from "./durable-objects/gateway-session";
import { CommunityStoreDO } from "./durable-objects/community-store";
import { WebhookIngressGuardDO } from "./durable-objects/webhook-ingress-guard";
import type { Env } from "./env";
import { createCloudflareRuntime } from "./runtime/cloudflare-runtime";
import { createCloudflareContext } from "./runtime/cloudflare-context";
import {
  GATEWAY_EVENT_QUEUE_NAME,
  handleGatewayEventQueueBatch,
} from "./runtime/gateway-event-queue-consumer";
import { R2_QUOTA_QUEUE_NAME, handleR2QuotaQueueBatch } from "./runtime/r2-quota-queue-consumer";
import {
  TICKET_RECOVERY_QUEUE_NAME,
  handleTicketRecoveryQueueBatch,
} from "./runtime/ticket-recovery-queue-consumer";
import { reconcileGuildR2ObjectsPage } from "./runtime/r2-quota-reconciliation";
import {
  WEBHOOK_PROXY_DELIVERY_QUEUE_NAME,
  handleWebhookProxyDeliveryQueueBatch,
} from "./runtime/webhook-proxy-delivery-queue-consumer";
import {
  STEAM_BAN_LOOKUP_QUEUE_NAME,
  handleSteamBanLookupQueueBatch,
} from "./runtime/steam-ban-lookup-queue-consumer";
import * as Sentry from "@sentry/cloudflare";
import {
  BILLING_SYNC_QUEUE_NAME,
  handleBillingSyncQueueBatch,
} from "./runtime/billing/cloudflare-billing-runtime";
import {
  BILLING_DELIVERY_QUEUE_NAME,
  handleBillingDeliveryQueueBatch,
} from "./runtime/billing/cloudflare-delivery-runtime";
import {
  COMMERCE_SYNC_QUEUE_NAME,
  handleCommerceSyncQueueBatch,
} from "./runtime/commerce/cloudflare-commerce-runtime";
import {
  COMMERCE_ROLE_QUEUE_NAME,
  handleCommerceRoleQueueBatch,
} from "./runtime/commerce/cloudflare-paid-role-runtime";
import { isConfiguredQueue } from "./runtime/queue-name";
import {
  SERVER_LEVELS_QUEUE_NAME,
  handleServerLevelQueueBatch,
} from "./runtime/server-level-queue-consumer";
import { handleReleaseSystemRoute } from "./runtime/release-smoke";
import { assertValidDiscordPublicKey } from "./discord";
import { createCloudflareGuildServiceSuspensionStore } from "./runtime/cloudflare-guild-service-suspension-store";
import {
  findGuildIdInValue,
  GuildServicePolicy,
  isGatewayGuildLifecycleEvent,
} from "./runtime/guild-service-policy";
import type { GuildServiceSuspensionStore } from "./runtime/contracts";
import {
  beginQueueMessageDelivery,
  DEFAULT_QUEUE_MAX_ATTEMPTS,
  queueDeliveryEmitter,
} from "./runtime/queue-delivery";
import { redactWebhookSecrets } from "./security/webhook-credentials";
import { logScheduledCompletion } from "./observability/scheduled-telemetry";
import {
  configureOperationalSentryClient,
  createOperationalReporter,
  reportOperationalEvent,
  type ReporterSentry,
} from "./observability/operational-reporter";

export { CommunityStoreDO };
export { WebhookIngressGuardDO };
export { GatewaySessionSqliteDO };
export { GatewaySessionSqliteDO as GatewaySessionDO };

Sentry.setAsyncLocalStorageAsyncContextStrategy();
configureOperationalSentryClient(Sentry as unknown as ReporterSentry);

const baseHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    assertValidDiscordPublicKey(env.DISCORD_PUBLIC_KEY);
    const releaseResponse = await handleReleaseSystemRoute(request, env);
    if (releaseResponse) return releaseResponse;
    if (isMaintenanceModeEnabled(env.HAF_MAINTENANCE_MODE)) {
      return cloudflareMaintenanceResponse();
    }
    return createCloudflareRuntime(env, ctx).fetch(request);
  },

  scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): void {
    const report = createOperationalReporter(runtimeEnvironment(env));
    if (isMaintenanceModeEnabled(env.HAF_MAINTENANCE_MODE)) {
      const gateway = createCloudflareContext(env).gateway;
      ctx.waitUntil(
        Promise.resolve()
          .then(async () => {
            if (!gateway.stop) throw new Error("Gateway stop is unavailable.");
            await gateway.stop();
          })
          .catch((error) => {
            report({
              severity: "critical",
              code: "scheduled.gateway_stop_failed",
              message: "Maintenance could not stop Cloudflare Gateway identities",
              cause: error,
              operation: "gateway_stop",
            });
            throw error;
          }),
      );
      return;
    }

    const runtime = createCloudflareRuntime(env);
    ctx.waitUntil(
      (async () => {
        try {
          const snapshots = await runtime.bootstrap();
          if (Array.isArray(snapshots)) {
            logScheduledCompletion(
              "gateway_bootstrap",
              { environment: runtimeEnvironment(env), workerVersion: env.WORKER_VERSION?.id },
              snapshots.length,
            );
          }
        } catch (error) {
          report({
            severity: "error",
            code: "scheduled.bootstrap_failed",
            message: "Scheduled bootstrap failed",
            cause: error,
            operation: "bootstrap",
          });
        }
        try {
          await runtime.refreshPlayerCount();
        } catch (error) {
          report({
            severity: "error",
            code: "scheduled.maintenance_sweep_failed",
            message: "Scheduled maintenance sweep failed",
            cause: error,
            operation: "maintenance_sweep",
          });
        }
        if (env.HAF_DB && env.TICKET_TRANSCRIPTS_BUCKET) {
          try {
            await reconcileGuildR2ObjectsPage({
              database: env.HAF_DB,
              bucket: env.TICKET_TRANSCRIPTS_BUCKET,
              bucketId: "ticket-transcripts",
            });
          } catch (error) {
            report({
              severity: "error",
              code: "scheduled.r2_reconciliation_failed",
              message: "Scheduled R2 quota reconciliation failed",
              cause: error,
              operation: "reconcile_r2_quota",
            });
          }
        }
      })(),
    );
  },

  async queue(batch: QueueBatch<unknown>, env: Env, ctx: ExecutionContext): Promise<void> {
    const stagingMode = env.STAGING_MODE === "true";
    const report = createOperationalReporter(runtimeEnvironment(env));
    const isGatewayEventQueue = isConfiguredQueue(
      batch.queue,
      GATEWAY_EVENT_QUEUE_NAME,
      stagingMode,
    );
    if (isConfiguredQueue(batch.queue, BILLING_SYNC_QUEUE_NAME, stagingMode)) {
      await handleBillingSyncQueueBatch(batch, env);
      return;
    }
    if (isConfiguredQueue(batch.queue, BILLING_DELIVERY_QUEUE_NAME, stagingMode)) {
      await handleBillingDeliveryQueueBatch(batch, env);
      return;
    }
    if (isConfiguredQueue(batch.queue, COMMERCE_SYNC_QUEUE_NAME, stagingMode)) {
      await handleCommerceSyncQueueBatch(
        batch,
        env,
        createCloudflareContext(env).commerceAdmin?.sellerReviews,
      );
      return;
    }
    if (isConfiguredQueue(batch.queue, COMMERCE_GAME_QUEUE_NAME, stagingMode)) {
      const runtime = createCloudflareContext(env).commerceGameAccess;
      if (!runtime) throw new Error("Commerce game delivery is unavailable.");
      await handleCommerceGameQueueBatch(batch, runtime);
      return;
    }
    if (isConfiguredQueue(batch.queue, COMMERCE_ROLE_QUEUE_NAME, stagingMode)) {
      await handleCommerceRoleQueueBatch(batch, env);
      return;
    }
    // Compensating recovery must run even while a Guild is suspended; otherwise
    // suspension can strand resources created before the partial failure.
    if (isConfiguredQueue(batch.queue, TICKET_RECOVERY_QUEUE_NAME, stagingMode)) {
      await handleTicketRecoveryQueueBatch(batch, env);
      return;
    }

    const activeBatch = env.HAF_DB
      ? await suppressSuspendedQueueMessages(
          batch,
          createCloudflareGuildServiceSuspensionStore(env.HAF_DB),
          report,
          isGatewayEventQueue ? isGatewayGuildLifecycleEvent : undefined,
        )
      : batch;
    if (activeBatch.messages.length === 0) return;
    if (isGatewayEventQueue) {
      await handleGatewayEventQueueBatch(activeBatch, env, console, {
        waitUntil: (promise) => ctx.waitUntil(promise),
      });
      return;
    }

    if (isConfiguredQueue(activeBatch.queue, WEBHOOK_PROXY_DELIVERY_QUEUE_NAME, stagingMode)) {
      await handleWebhookProxyDeliveryQueueBatch(activeBatch, env);
      return;
    }

    if (isConfiguredQueue(activeBatch.queue, STEAM_BAN_LOOKUP_QUEUE_NAME, stagingMode)) {
      await handleSteamBanLookupQueueBatch(activeBatch, env);
      return;
    }

    if (isConfiguredQueue(activeBatch.queue, R2_QUOTA_QUEUE_NAME, stagingMode)) {
      await handleR2QuotaQueueBatch(activeBatch, env);
      return;
    }
    if (isConfiguredQueue(activeBatch.queue, SERVER_LEVELS_QUEUE_NAME, stagingMode)) {
      await handleServerLevelQueueBatch(activeBatch, env);
      return;
    }
    const error = new Error(`No Queue consumer is configured for ${activeBatch.queue}.`);
    report({
      severity: "critical",
      code: "queue.unknown_consumer",
      message: "No Queue consumer is configured",
      cause: error,
      operation: "queue_dispatch",
      context: { queue: activeBatch.queue, messageCount: activeBatch.messages.length },
      captureToSentry: false,
    });
    throw error;
  },
};

export async function suppressSuspendedQueueMessages<T>(
  batch: QueueBatch<T>,
  store: GuildServiceSuspensionStore,
  report: typeof reportOperationalEvent = reportOperationalEvent,
  allowSuspendedMessage?: (body: T) => boolean,
): Promise<QueueBatch<T>> {
  const policy = new GuildServicePolicy(store);
  const messages: Message<T>[] = [];
  const emitDeliveryEvent = queueDeliveryEmitter(console);
  for (const message of batch.messages) {
    const guildId = findGuildIdInValue(message.body);
    try {
      if ((await policy.isGuildSuspended(guildId)) && !allowSuspendedMessage?.(message.body)) {
        report({
          severity: "warning",
          code: "queue.guild_suspended",
          message: "Queue message skipped for suspended Guild",
          guildId: guildId ?? undefined,
          operation: "queue.suspension_filter",
          context: { queue: batch.queue, messageId: message.id, attempts: message.attempts },
          captureToSentry: false,
        });
        beginQueueMessageDelivery(batch.queue, message, {
          maxAttempts: DEFAULT_QUEUE_MAX_ATTEMPTS,
          emit: emitDeliveryEvent,
        }).settle({ status: "terminal", reasonCode: "guild_suspended" });
      } else {
        messages.push(message);
      }
    } catch (error) {
      const exhausted = message.attempts >= DEFAULT_QUEUE_MAX_ATTEMPTS;
      report({
        severity: "error",
        code: "queue.suspension_store_unavailable",
        message: "Queue suspension check failed",
        cause: error,
        guildId: guildId ?? undefined,
        operation: "queue.suspension_filter",
        context: {
          queue: batch.queue,
          messageId: message.id,
          attempts: message.attempts,
          exhausted,
        },
        captureToSentry: exhausted,
      });
      beginQueueMessageDelivery(batch.queue, message, {
        maxAttempts: DEFAULT_QUEUE_MAX_ATTEMPTS,
        emit: emitDeliveryEvent,
      }).settle({ status: "retry", reasonCode: "suspension_store_unavailable" });
    }
  }
  return { ...batch, messages } as QueueBatch<T>;
}

function runtimeEnvironment(env: Env): "staging" | "production" {
  return env.STAGING_MODE === "true" ? "staging" : "production";
}

function isMaintenanceModeEnabled(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || ["false", "0", "no"].includes(normalized)) return false;
  if (["true", "1", "yes"].includes(normalized)) return true;
  throw new Error("HAF_MAINTENANCE_MODE must be true or false.");
}

function cloudflareMaintenanceResponse(): Response {
  return new Response("HAF Bot is temporarily unavailable during a data migration.", {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
      "retry-after": "60",
      "x-haf-maintenance": "migration-freeze",
    },
  });
}

const sentryHandler = Sentry.withSentry<Env, unknown, unknown, typeof baseHandler>(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    environment: runtimeEnvironment(env),
    release: env.WORKER_VERSION?.id,
    sendDefaultPii: true,
    beforeSend: (event) => redactWebhookSecrets(event),
    beforeBreadcrumb: (breadcrumb) => redactWebhookSecrets(breadcrumb),
  }),
  { ...baseHandler },
);

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return env.SENTRY_DSN
      ? sentryHandler.fetch(request, env, ctx)
      : baseHandler.fetch(request, env, ctx);
  },
  scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    return env.SENTRY_DSN
      ? sentryHandler.scheduled(controller, env, ctx)
      : baseHandler.scheduled(controller, env, ctx);
  },
  queue(batch: QueueBatch<unknown>, env: Env, ctx: ExecutionContext) {
    return env.SENTRY_DSN
      ? sentryHandler.queue(batch, env, ctx)
      : baseHandler.queue(batch, env, ctx);
  },
};
