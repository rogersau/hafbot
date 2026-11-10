import { createChannelMessage, suppressMentions } from "../../discord/messages";
import { createAdminFeedback, adminFeedbackBodySchema } from "../../contracts/admin/feedback";
import { adminErrorEnvelopeSchema } from "../../contracts/admin";
import { AdminRouteError, adminRouteErrors } from "../admin-errors/admin-route-error";
import { defineRoute, type Route } from "../admin-route-registry";
import type { AdminRoutesOptions } from "./index";
import type { AdminFeedbackRecord } from "../contracts/admin-feedback-store";
import { reportOperationalEvent } from "../../observability/operational-reporter";
import { redactWebhookSecrets } from "../../security/webhook-credentials";
import type { z } from "zod";
import { isRecord } from "../../unknown-parse";
import { createAdminAccessDeniedResponse } from "../admin-access";

const HOUR_MS = 60 * 60 * 1_000;
const MAX_REPORTS_PER_HOUR = 5;
const NOTIFICATION_TIMEOUT_MS = 12_000;
const STATUS_UPDATE_TIMEOUT_MS = 3_000;
type FeedbackBody = z.infer<typeof adminFeedbackBodySchema>;

export function createAdminFeedbackRoute(
  options: AdminRoutesOptions,
): Array<Route<unknown, FeedbackBody, Response>> {
  const store = options.stores.adminFeedback;
  if (!store) return [];
  return [
    defineRoute({
      ...createAdminFeedback,
      feature: undefined,
      body: adminFeedbackBodySchema,
      maxBodyBytes: 8_192,
      success: createAdminFeedback.success.schema,
      errors: adminErrorEnvelopeSchema,
      access: async ({ request, body }) => {
        const input = body as { guildId?: string; workspaceId?: string };
        const requirement = input.workspaceId
          ? {
              mode: "read" as const,
              guildId: input.guildId,
              workspaceId: input.workspaceId,
              workspaceOnly: true,
            }
          : input.guildId
            ? { mode: "read" as const, guildId: input.guildId }
            : null;
        if (requirement) {
          const access = await options.adminAccess.authorize(request, requirement);
          if (!access.ok) return createAdminAccessDeniedResponse(access.error);
        }
        return { mode: "read", customerSessionOnly: true };
      },
      handler: async ({ request, body }) => {
        if (
          [
            body.summary,
            body.route,
            body.pageLabel,
            body.workspaceId,
            body.correlationId,
            body.errorCode,
            body.workerVersion,
            body.diagnostics?.browser,
            body.diagnostics?.os,
          ].some((value) => value !== undefined && hasControlCharacters(value)) ||
          hasControlCharacters(body.description, true)
        ) {
          throw adminRouteErrors.invalidRequest([
            {
              path: "body",
              code: "control_character",
              message: "Control characters are not allowed.",
            },
          ]);
        }
        if (
          [
            body.summary,
            body.description,
            body.route,
            body.pageLabel,
            body.workspaceId,
            body.correlationId,
            body.errorCode,
            body.workerVersion,
          ]
            .filter((value): value is string => value !== undefined)
            .some((value) => value.trim().length === 0)
        ) {
          throw adminRouteErrors.invalidRequest([
            { path: "body", code: "blank", message: "Text fields must not be blank." },
          ]);
        }
        const session = await options.readCustomerAdminSession?.(request);
        if (!session) throw adminRouteErrors.authenticationRequired();
        const now = Date.now();
        const windowStartMs = now - HOUR_MS;
        if (
          (await store.countRecentByReporter(session.user.id, windowStartMs)) >=
          MAX_REPORTS_PER_HOUR
        ) {
          const oldestCreatedAtMs = await store.readOldestRecentCreatedAtMs(
            session.user.id,
            windowStartMs,
          );
          const retryAfterSeconds =
            oldestCreatedAtMs === null
              ? HOUR_MS / 1_000
              : Math.max(1, Math.ceil((oldestCreatedAtMs + HOUR_MS - now) / 1_000));
          throw new AdminRouteError({
            code: "feedback_rate_limited",
            status: 429,
            safeMessage: "Feedback rate limit reached.",
            retryable: true,
            retryAfterSeconds,
            action: "wait",
          });
        }
        const diagnostics = body.diagnostics;
        if (diagnostics && !diagnostics.included && (diagnostics.browser || diagnostics.os)) {
          throw adminRouteErrors.invalidRequest([
            { path: "diagnostics", code: "invalid", message: "Diagnostic fields require opt-in." },
          ]);
        }
        const derived = diagnostics?.included
          ? parseUserAgent(request.headers.get("User-Agent"))
          : null;
        const browser = diagnostics?.included
          ? (diagnostics.browser ?? derived?.browser ?? null)
          : null;
        const os = diagnostics?.included ? (diagnostics.os ?? derived?.os ?? null) : null;
        let record: AdminFeedbackRecord | undefined;
        for (let attempt = 0; attempt < 3 && !record; attempt += 1) {
          const id = randomOpaqueId();
          const reference = `FB-${randomOpaqueId(8).toUpperCase()}`;
          const candidate: AdminFeedbackRecord = {
            id,
            reference,
            category: body.category,
            summary: redact(body.summary, 200),
            description: redact(body.description, 4_000),
            reporterUserId: session.user.id,
            guildId: body.guildId ?? null,
            workspaceId: body.workspaceId ?? null,
            route: redact(body.route, 200),
            pageLabel: body.pageLabel ? redact(body.pageLabel, 120) : null,
            correlationId: body.correlationId ?? null,
            errorCode: body.errorCode ?? null,
            rayId: sanitizeHeaderValue(request.headers.get("CF-Ray"), 128),
            workerVersion:
              sanitizeHeaderValue(options.workerVersion ?? body.workerVersion ?? "unknown", 128) ??
              "unknown",
            environment: options.environment ?? "production",
            diagnosticsIncluded: Boolean(diagnostics?.included),
            browser: browser ? redact(browser, 80) : null,
            os: os ? redact(os, 80) : null,
            notificationState: "pending",
            notificationErrorCode: null,
            createdAtMs: now,
          };
          try {
            await store.insert(candidate);
            record = candidate;
          } catch (error) {
            if (!isUniqueConstraintCollision(error)) {
              throw adminRouteErrors.databaseUnavailable(error);
            }
            if (attempt === 2) throw adminRouteErrors.databaseUnavailable();
          }
        }
        if (!record) throw adminRouteErrors.databaseUnavailable();
        const notificationTask = deliverAdminFeedbackNotification(record, options);
        if (options.waitUntil) options.waitUntil(notificationTask);
        else void notificationTask;
        return Response.json(
          { ok: true, reference: record.reference, receivedAtMs: now },
          { status: 201 },
        );
      },
    }),
  ];
}

export async function deliverAdminFeedbackNotification(
  record: AdminFeedbackRecord,
  options: AdminRoutesOptions,
  deliveryTimeoutMs = NOTIFICATION_TIMEOUT_MS,
  statusUpdateTimeoutMs = STATUS_UPDATE_TIMEOUT_MS,
): Promise<void> {
  const store = options.stores.adminFeedback;
  if (!store) return;
  let state: "sent" | "failed" = "failed";
  let errorCode = "channel_not_configured";
  try {
    await withTimeout(
      options.notifyAdminFeedback
        ? options.notifyAdminFeedback(record)
        : sendAdminFeedbackNotification(record, options),
      deliveryTimeoutMs,
      "notification_timeout",
    );
    state = "sent";
    errorCode = "";
  } catch (error) {
    errorCode = classifyNotificationError(error);
    safelyReport(options, {
      severity: "error",
      code: "admin.feedback_notification_failed",
      message: "Admin feedback notification failed",
      context: { ref: record.reference, errorCode },
    });
  }
  try {
    await withTimeout(
      store.updateNotification(record.id, state, state === "failed" ? errorCode : null),
      statusUpdateTimeoutMs,
      "status_update_timeout",
    );
  } catch {
    safelyReport(options, {
      severity: "error",
      code: "admin.feedback_status_update_failed",
      message: "Admin feedback notification status update failed",
      context: { ref: record.reference, errorCode: "status_update_failed" },
    });
  }
}

async function sendAdminFeedbackNotification(
  record: AdminFeedbackRecord,
  options: AdminRoutesOptions,
): Promise<void> {
  if (!options.opsFeedbackChannelId) throw new Error("channel_not_configured");
  await createChannelMessage(
    options.opsFeedbackChannelId,
    {
      embeds: [
        {
          title: `${record.reference} · ${record.category}`,
          description: record.description,
          fields: [
            { name: "Summary", value: record.summary },
            { name: "Reporter", value: "Authenticated dashboard user" },
            ...(record.guildId ? [{ name: "Guild", value: record.guildId }] : []),
            ...(record.workspaceId ? [{ name: "Workspace", value: record.workspaceId }] : []),
            { name: "Route", value: record.route },
            ...(record.pageLabel ? [{ name: "Page", value: record.pageLabel }] : []),
            { name: "Environment", value: record.environment },
            ...(record.diagnosticsIncluded
              ? [
                  {
                    name: "Diagnostics",
                    value:
                      [record.browser, record.os].filter(Boolean).join(" · ") ||
                      "Opted in; no values supplied",
                  },
                ]
              : []),
            ...(record.correlationId ? [{ name: "Correlation", value: record.correlationId }] : []),
            ...(record.errorCode ? [{ name: "Error code", value: record.errorCode }] : []),
            ...(record.rayId ? [{ name: "CF-Ray", value: record.rayId }] : []),
            ...(record.workerVersion ? [{ name: "Worker", value: record.workerVersion }] : []),
          ],
          footer: { text: record.reference },
        },
      ],
      allowed_mentions: suppressMentions(),
    },
    options.discordBotToken,
  );
}

function safelyReport(
  options: AdminRoutesOptions,
  event: Parameters<typeof reportOperationalEvent>[0],
): void {
  try {
    (options.reportOperationalEvent ?? reportOperationalEvent)(event);
  } catch {
    /* telemetry is best effort */
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(reason)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function randomOpaqueId(bytes = 16): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return Array.from(data, (value) => value.toString(16).padStart(2, "0")).join("");
}
function redact(value: string, max: number): string {
  return redactWebhookSecrets(value).slice(0, max);
}
function classifyNotificationError(error: unknown): string {
  if (error instanceof Error && error.message === "channel_not_configured") {
    return "channel_not_configured";
  }
  if (error instanceof Error && error.message === "notification_timeout") {
    return "notification_timeout";
  }
  const status = isRecord(error) ? Number(error.status) : 0;
  if (status === 429) return "discord_rate_limited";
  if (status >= 400 && status < 500) return "discord_rejected";
  return "discord_unavailable";
}

function isUniqueConstraintCollision(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    /(unique|primary key)/i.test(message) &&
    /admin_feedback\.(reference|id)|admin_feedback_(reference|id)/i.test(message)
  );
}

function parseUserAgent(value: string | null): { browser: string; os: string } | null {
  if (!value) return null;
  const ua = value.slice(0, 256);
  const browser = /Edg\/?([\d.]+)/i.test(ua)
    ? "Edge"
    : /Chrome\/?([\d.]+)/i.test(ua)
      ? "Chrome"
      : /Firefox\/?([\d.]+)/i.test(ua)
        ? "Firefox"
        : /Safari\/?([\d.]+)/i.test(ua)
          ? "Safari"
          : "Other";
  const os = /iPhone|iPad/i.test(ua)
    ? "iOS"
    : /Windows/i.test(ua)
      ? "Windows"
      : /Mac OS X/i.test(ua)
        ? "macOS"
        : /Android/i.test(ua)
          ? "Android"
          : /Linux/i.test(ua)
            ? "Linux"
            : "Other";
  return { browser, os };
}

function sanitizeHeaderValue(value: string | null, max: number): string | null {
  if (!value) return null;
  const bounded = value.slice(0, max);
  return hasControlCharacters(bounded) || !/^[A-Za-z0-9._:-]+$/.test(bounded) ? null : bounded;
}

function hasControlCharacters(value: string, allowDescriptionWhitespace = false): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0 ||
      code === 127 ||
      (code < 32 && !(allowDescriptionWhitespace && (code === 9 || code === 10 || code === 13)))
    )
      return true;
  }
  return false;
}
