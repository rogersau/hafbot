import assert from "node:assert/strict";
import test from "node:test";

import { createGatewayBotController } from "./support/sqlite/runtime/gateway-bot-orchestration";
import { SafeDiagnosticError } from "../src/observability/safe-diagnostic-error";
import {
  __testing,
  createOperationalReporter,
  reportOperationalEvent,
} from "../src/observability/operational-reporter";
import { redactWebhookSecrets } from "../src/security/webhook-credentials";

function sentryRecorder() {
  const levels: string[] = [];
  const tags: Record<string, string>[] = [];
  const contexts: Record<string, unknown>[] = [];
  const exceptions: unknown[] = [];
  const messages: Array<{ message: string; level: string }> = [];
  const client = {
    withScope(
      callback: (scope: {
        setLevel: (level: string) => void;
        setTag: (key: string, value: string) => void;
        setContext: (key: string, value: Record<string, unknown>) => void;
      }) => void,
    ) {
      const current: Record<string, string> = {};
      tags.push(current);
      const scope = {
        setLevel: (level: string) => levels.push(level),
        setTag: (key: string, value: string) => {
          current[key] = value;
        },
        setContext: (key: string, value: Record<string, unknown>) =>
          contexts.push({ [key]: value }),
      };
      callback(scope);
    },
    captureException: (error: unknown) => exceptions.push(error),
    captureMessage: (message: string, level?: unknown) =>
      messages.push({ message, level: String(level) }),
  };
  return { client, levels, tags, contexts, exceptions, messages };
}

test("Sentry mapping covers severity, tags, identifiers, context, and cause types", () => {
  const recorder = sentryRecorder();
  __testing.setSentryClient(recorder.client);
  try {
    reportOperationalEvent({
      severity: "warning",
      code: "ops.warning",
      message: "warning",
      cause: "non-error cause",
      guildId: "guild",
      workspaceId: "workspace",
      operation: "operation",
      environment: "staging",
      correlationId: "correlation",
      observationId: "observation",
      rayId: "ray",
      context: { safe: true },
    });
    reportOperationalEvent({
      severity: "error",
      code: "ops.error",
      message: "error",
      cause: new Error("boom"),
    });
    reportOperationalEvent({ severity: "critical", code: "ops.critical", message: "critical" });
  } finally {
    __testing.resetSentryClient();
  }
  assert.deepEqual(recorder.levels, ["warning", "error", "fatal"]);
  assert.equal(recorder.messages[0]?.level, "warning");
  assert.deepEqual(recorder.messages[1], { message: "critical", level: "fatal" });
  assert.equal(recorder.exceptions.length, 1);
  const tagSet = recorder.tags.find((tags) => tags.event_code === "ops.warning");
  assert.deepEqual(tagSet, {
    operational_event: "haf.operational",
    event_code: "ops.warning",
    severity: "warning",
    guild_id: "guild",
    workspace_id: "workspace",
    operation: "operation",
    environment: "staging",
    correlation_id: "correlation",
    observation_id: "observation",
    cf_ray: "ray",
  });
  assert.deepEqual(recorder.contexts[0], { operational: { safe: true } });
});

test("operational reporter emits one stable structured payload for each severity", () => {
  const warnings: unknown[] = [];
  const errors: unknown[] = [];
  const originalWarn = console.warn;
  const originalError = console.error;
  console.warn = (...args: unknown[]) => warnings.push(args[0]);
  console.error = (...args: unknown[]) => errors.push(args[0]);
  try {
    reportOperationalEvent({ severity: "warning", code: "worker.warning", message: "warn" });
    reportOperationalEvent({ severity: "error", code: "worker.error", message: "error" });
    reportOperationalEvent({ severity: "critical", code: "worker.critical", message: "critical" });
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }
  assert.equal(warnings.length, 1);
  assert.equal(errors.length, 2);
  assert.deepEqual(warnings[0], {
    event: "haf.operational",
    severity: "warning",
    code: "worker.warning",
    message: "warn",
  });
  assert.equal((errors[0] as { severity: string }).severity, "error");
  assert.equal((errors[1] as { severity: string }).severity, "critical");
});

test("bound reporters add environment and log-only events skip Sentry", () => {
  const recorder = sentryRecorder();
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args[0]);
  __testing.setSentryClient(recorder.client);
  try {
    createOperationalReporter("staging")({
      severity: "warning",
      code: "queue.expected",
      message: "expected retry",
      captureToSentry: false,
    });
  } finally {
    __testing.resetSentryClient();
    console.warn = originalWarn;
  }
  assert.equal((warnings[0] as { environment: string }).environment, "staging");
  assert.equal(recorder.messages.length, 0);
  assert.equal(recorder.exceptions.length, 0);
});

test("messages and causes redact credentials before console emission", () => {
  const errors: unknown[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => errors.push(args[0]);
  try {
    reportOperationalEvent({
      severity: "error",
      code: "worker.secret",
      message: "authorization=top-secret",
      cause: new Error("token=another-secret"),
    });
  } finally {
    console.error = originalError;
  }
  const output = JSON.stringify(errors[0]);
  assert.doesNotMatch(output, /top-secret|another-secret/);
  assert.match(output, /REDACTED/);
});

test("aggregate operational failures retain safe owner causes in logs and Sentry", () => {
  const recorder = sentryRecorder();
  const logs: unknown[] = [];
  const originalError = console.error;
  const providerError = new SafeDiagnosticError("Stripe unavailable token=provider-secret", {
    cause: { password: "nested-secret", category: "transient" },
  });
  const ownerFailure = new SafeDiagnosticError("Plan Owner owner-a reconciliation failed.", {
    cause: providerError,
  });
  console.error = (...args: unknown[]) => logs.push(args[0]);
  __testing.setSentryClient(recorder.client);
  try {
    reportOperationalEvent({
      severity: "error",
      code: "scheduled.task_failed",
      message: "Billing owner reconciliation failed",
      cause: new AggregateError([ownerFailure], "Billing reconciliation failed"),
    });
  } finally {
    console.error = originalError;
    __testing.resetSentryClient();
  }

  const captured = recorder.exceptions[0];
  assert.ok(captured instanceof AggregateError);
  assert.equal(captured.errors.length, 1);
  const safeOwner = captured.errors[0];
  assert.ok(safeOwner instanceof Error);
  assert.match(safeOwner.message, /owner-a/);
  const safeProvider = safeOwner.cause;
  assert.ok(safeProvider instanceof Error);
  assert.equal(safeProvider.name, "Error");
  assert.match(safeProvider.message, /Stripe unavailable.*REDACTED/);
  assert.doesNotMatch(safeProvider.stack ?? "", /provider-secret/);
  assert.equal(safeProvider.cause, "[non-error cause omitted]");
  const logged = JSON.stringify(logs);
  assert.match(logged, /owner-a.*Stripe unavailable/);
  assert.doesNotMatch(logged, /provider-secret|nested-secret/);
  assert.match(logged, /REDACTED/);
  assert.match(providerError.message, /provider-secret/);
});

test("gateway aggregate failures keep provider payloads out of operational telemetry", async () => {
  const recorder = sentryRecorder();
  const logs: unknown[] = [];
  const originalError = console.error;
  const providerBody =
    '{"token":"provider-secret","customer_email":"customer@example.com","message":"private customer detail"}';
  const controller = createGatewayBotController({
    enabled: true,
    standardBotToken: "unused",
    gatewayNamespace: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () =>
          new Response(providerBody, {
            status: 503,
            statusText: "Service Unavailable",
          }),
      }),
    },
    whiteLabelBots: { listActiveWhiteLabelBots: async () => [] },
    resolveToken: async () => "unused",
  });
  let aggregateFailure: unknown;
  await assert.rejects(
    async () => {
      await controller.stop!();
    },
    (error: unknown) => {
      aggregateFailure = error;
      return error instanceof AggregateError;
    },
  );
  assert.ok(aggregateFailure instanceof AggregateError);
  assert.equal(aggregateFailure.errors.length, 1);

  console.error = (...args: unknown[]) => logs.push(args[0]);
  __testing.setSentryClient(recorder.client);
  try {
    reportOperationalEvent({
      severity: "critical",
      code: "scheduled.gateway_stop_failed",
      message: "Gateway stop failed",
      cause: aggregateFailure,
      operation: "gateway_stop",
    });
  } finally {
    console.error = originalError;
    __testing.resetSentryClient();
  }

  const output = JSON.stringify({ logs, exceptions: recorder.exceptions });
  assert.doesNotMatch(output, /provider-secret|customer@example\.com|private customer detail/);
  assert.match(output, /Cloudflare gateway request failed: 503/);
  const sentryFailure = recorder.exceptions[0];
  assert.ok(sentryFailure instanceof AggregateError);
  assert.equal(sentryFailure.errors[0]?.message, "Cloudflare gateway request failed: 503");
});

test("gateway transport rejections cannot expose unknown nested error text or payloads", async () => {
  const recorder = sentryRecorder();
  const logs: unknown[] = [];
  const originalError = console.error;
  const upstream = new Error('Customer private@example.com: {"token":"opaque-value"}', {
    cause: { detail: "private customer detail" },
  });
  upstream.name = "private customer name";
  upstream.stack = "private upstream stack";
  const controller = createGatewayBotController({
    enabled: true,
    standardBotToken: "unused",
    gatewayNamespace: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => {
          throw upstream;
        },
      }),
    },
    whiteLabelBots: {
      listActiveWhiteLabelBots: async () => {
        throw "private discovery payload";
      },
    },
    resolveToken: async () => "unused",
  });
  console.error = (...args: unknown[]) => logs.push(args[0]);
  __testing.setSentryClient(recorder.client);
  try {
    await assert.rejects(
      async () => {
        await controller.stop!();
      },
      (cause: unknown) => {
        assert.ok(cause instanceof AggregateError);
        reportOperationalEvent({
          severity: "error",
          code: "scheduled.gateway_stop_failed",
          message: "Gateway stop failed",
          cause,
        });
        return true;
      },
    );
  } finally {
    console.error = originalError;
    __testing.resetSentryClient();
  }
  const captured = recorder.exceptions[0];
  assert.ok(captured instanceof AggregateError);
  assert.equal(captured.errors.length, 2);
  const errors = captured.errors.map((error: unknown) =>
    error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack, cause: error.cause }
      : error,
  );
  assert.doesNotMatch(JSON.stringify({ logs, errors }), /private|opaque-value/);
  assert.equal(captured.errors[0].name, "Error");
  assert.match(captured.errors[0].message, /omitted/);
  assert.equal(captured.errors[0].stack, undefined);
  assert.match(String(captured.errors[1]), /omitted/);
  assert.match(upstream.message, /private@example.com/);
});

test("aggregate operational errors are bounded and cyclic causes still reach Sentry", () => {
  const recorder = sentryRecorder();
  const logs: unknown[] = [];
  const originalError = console.error;
  const cycle = new Error("cycle");
  cycle.cause = cycle;
  let deep = new Error("leaf");
  for (let index = 0; index < 12; index += 1) {
    deep = new Error(`level-${index}`, { cause: deep });
  }
  const failure = new AggregateError(
    [cycle, deep, ...Array.from({ length: 30 }, () => new Error("child"))],
    "x".repeat(2_000),
  );
  console.error = (...args: unknown[]) => logs.push(args[0]);
  __testing.setSentryClient(recorder.client);
  try {
    reportOperationalEvent({
      severity: "error",
      code: "scheduled.task_failed",
      message: "bounded aggregate",
      cause: failure,
    });
  } finally {
    console.error = originalError;
    __testing.resetSentryClient();
  }
  const captured = recorder.exceptions[0];
  assert.ok(captured instanceof AggregateError);
  assert.equal(captured.errors.length, 20);
  assert.ok(captured.message.length <= 1_000);
  assert.ok(captured.errors[0].cause instanceof Error);
  assert.match(captured.errors[0].cause.message, /circular/);
  let cursor: unknown = captured.errors[1];
  let count = 0;
  while (cursor instanceof Error) {
    count += 1;
    if (cursor.cause === undefined) assert.match(cursor.message, /truncated-depth/);
    cursor = cursor.cause;
  }
  assert.ok(count <= 6);
  assert.equal(logs.length, 1);
  assert.doesNotThrow(() => JSON.stringify(logs));
});

test("malformed event fields are normalised and bounded", () => {
  const warnings: unknown[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => warnings.push(args[0]);
  try {
    reportOperationalEvent({
      severity: "bogus" as never,
      code: "NOT VALID" as string,
      message: "x".repeat(2_000),
      guildId: "g".repeat(500),
      context: { unsupported: Symbol("x"), nonFinite: Infinity },
    });
  } finally {
    console.warn = originalWarn;
  }
  const payload = warnings[0] as Record<string, unknown>;
  assert.equal(payload.severity, "warning");
  assert.equal(payload.code, "invalid_event_code");
  assert.ok((payload.message as string).length <= 1_000);
  assert.ok((payload.guildId as string).length <= 200);
  assert.deepEqual(payload.context, { nonFinite: "[non-finite]" });
});

test("operational context is bounded, nested-redacted, serialisable, and cycle safe", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  const context = __testing.sanitize({
    authorization: "Bearer secret",
    nested: { webhook: "https://discord.com/api/webhooks/123456/token" },
    circular,
    values: [1, BigInt(2), Number.NaN, () => "ignored"],
    huge: "x".repeat(2_000),
  }) as Record<string, unknown>;
  assert.equal(context.authorization, "[redacted]");
  assert.equal((context.nested as Record<string, unknown>).webhook, "[redacted]");
  assert.equal((context.circular as Record<string, unknown>).self, "[circular]");
  assert.deepEqual(context.values, [1, "2", "[non-finite]", undefined]);
  assert.match(context.huge as string, /truncated/);
  assert.doesNotThrow(() => JSON.stringify(context));
});

test("reporting failures are isolated from customer operations", () => {
  const originalError = console.error;
  let calls = 0;
  console.error = () => {
    calls += 1;
    throw new Error("console unavailable");
  };
  try {
    assert.doesNotThrow(() =>
      reportOperationalEvent({
        severity: "error",
        code: "worker.failure",
        message: "failure",
        cause: new Error("original"),
      }),
    );
  } finally {
    console.error = originalError;
  }
  assert.ok(calls >= 1);
});

test("webhook redaction covers nested credentials and Error stacks", () => {
  const error = new Error("https://discord.com/api/webhooks/123456/token_value");
  error.stack = `${error.name}: ${error.message}`;
  const redacted = redactWebhookSecrets({ authorization: "Bearer token", error });
  assert.equal((redacted as { authorization: string }).authorization, "[REDACTED]");
  assert.doesNotMatch(JSON.stringify(redacted), /token_value/);
});
