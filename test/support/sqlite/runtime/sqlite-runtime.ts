import type { Env } from "../../test-env";
import { createOperationalReporter } from "../../../../src/observability/operational-reporter";
import { createRuntimeApp } from "../../../../src/runtime/app";
import { createSqliteContext } from "./sqlite-context";
import type { WebhookProxyConfigCache } from "../../../../src/services/webhook-proxy-service";
import type { BanCaseSourceCache } from "../../../../src/services/ban-case-service";
import {
  createEnvironmentProductAnalytics,
  withGuildAnalyticsPreference,
  withProductAnalyticsWaitUntil,
} from "../../../../src/product-analytics";
import { maintainServerLevels } from "../../../../src/runtime/server-level-queue-consumer";

const publicWebhookSourceCaches = {
  webhookProxy: new Map() as WebhookProxyConfigCache,
  banCase: new Map() as BanCaseSourceCache,
};

export function createSqliteRuntime(env: Env, ctx?: ExecutionContext) {
  const context = createSqliteContext(env);
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
    sweepServerLevels: () => maintainServerLevels(env, context),
  });
}
