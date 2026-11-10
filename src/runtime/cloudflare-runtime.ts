import type { Env } from "../env";
import { createOperationalReporter } from "../observability/operational-reporter";
import { createRuntimeApp } from "./app";
import { createCloudflareContext } from "./cloudflare-context";
import type { WebhookProxyConfigCache } from "../services/webhook-proxy-service";
import type { BanCaseSourceCache } from "../services/ban-case-service";
import {
  createEnvironmentProductAnalytics,
  withGuildAnalyticsPreference,
  withProductAnalyticsWaitUntil,
} from "../product-analytics";
import { maintainServerLevels } from "./server-level-queue-consumer";

const publicWebhookSourceCaches = {
  webhookProxy: new Map() as WebhookProxyConfigCache,
  banCase: new Map() as BanCaseSourceCache,
};

export function createCloudflareRuntime(env: Env, ctx?: ExecutionContext) {
  const context = createCloudflareContext(env);
  const environment = env.STAGING_MODE === "true" ? "staging" : "production";
  const baseProductAnalytics = createEnvironmentProductAnalytics(env);
  const preferenceAwareProductAnalytics = context.stores.productAnalyticsPreferences
    ? withGuildAnalyticsPreference(baseProductAnalytics, (guildId) =>
        context.stores.productAnalyticsPreferences!.readEnabled(guildId),
      )
    : baseProductAnalytics;
  const waitUntil =
    ctx && typeof ctx.waitUntil === "function"
      ? (promise: Promise<unknown>) => ctx.waitUntil(promise)
      : undefined;
  const productAnalytics = waitUntil
    ? withProductAnalyticsWaitUntil(preferenceAwareProductAnalytics, waitUntil)
    : preferenceAwareProductAnalytics;
  return createRuntimeApp({
    ...context,
    publicWebhookSourceCaches,
    environment,
    reportOperationalEvent: createOperationalReporter(environment),
    productAnalytics,
    waitUntil,
    sweepServerLevels: () => maintainServerLevels(env),
  });
}
