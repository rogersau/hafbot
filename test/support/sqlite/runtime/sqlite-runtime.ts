import type { Env } from "../../test-env";
import { createOperationalReporter } from "../../../../src/observability/operational-reporter";
import { createRuntimeApp } from "../../../../src/runtime/app";
import { createSqliteContext } from "./sqlite-context";
import type { WebhookProxyConfigCache } from "../../../../src/services/webhook-proxy-service";
import type { BanCaseSourceCache } from "../../../../src/services/ban-case-service";
import { maintainServerLevels } from "../../../../src/runtime/server-level-queue-consumer";

const publicWebhookSourceCaches = {
  webhookProxy: new Map() as WebhookProxyConfigCache,
  banCase: new Map() as BanCaseSourceCache,
};

export function createSqliteRuntime(env: Env, ctx?: ExecutionContext) {
  const waitUntil =
    ctx && typeof ctx.waitUntil === "function"
      ? (promise: Promise<unknown>) => ctx.waitUntil(promise)
      : undefined;
  const context = createSqliteContext(env, {}, { waitUntil, publicWebhookSourceCaches });
  return createRuntimeApp({
    ...context,
    reportOperationalEvent: createOperationalReporter(
      env.STAGING_MODE === "true" ? "staging" : "production",
    ),
    waitUntil,
    sweepServerLevels: () =>
      maintainServerLevels(env, context, {
        processor: context.services.serverLevelProcessor!,
      }),
  });
}
