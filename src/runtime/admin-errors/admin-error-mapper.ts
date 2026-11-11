import { isDatabaseUnavailable } from "../database-availability";
import { isRecord } from "../../unknown-parse";
import {
  ADMIN_ERROR_CODES,
  isAdminErrorEnvelope,
  type AdminErrorCode,
  type AdminErrorEnvelopeV1,
  type AdminRecoveryAction,
  type AdminStaleReason,
} from "./admin-error-contract";
import type { AdminRequestContext } from "./admin-request-context";
import { AdminRouteError } from "./admin-route-error";
import { DiscordApiError } from "../../discord/client";
import { GuildResourceValidationError } from "../../discord/guild-resource-validator";
import { reportOperationalEvent } from "../../observability/operational-reporter";

const STATUS_DEFAULTS: Record<
  number,
  { code: AdminErrorCode; message: string; action?: AdminRecoveryAction }
> = {
  400: { code: "invalid_request", message: "Invalid request.", action: "fix_fields" },
  401: { code: "authentication_required", message: "Sign in to continue.", action: "sign_in" },
  402: {
    code: "entitlement_required",
    message: "This feature requires an upgraded plan.",
    action: "upgrade",
  },
  403: { code: "permission_denied", message: "You do not have permission to perform this action." },
  404: { code: "resource_not_found", message: "Not found." },
  409: { code: "conflict", message: "The request conflicts with the current state." },
  429: {
    code: "service_unavailable",
    message: "The service is temporarily unavailable.",
    action: "wait",
  },
};

export function mapAdminFailure(error: unknown, context: AdminRequestContext): Response {
  if (error instanceof GuildResourceValidationError) {
    return errorResponse(context, 400, {
      error: "Invalid Discord resource.",
      code: "invalid_request",
      retryable: false,
      action: "fix_fields",
    });
  }
  if (error instanceof AdminRouteError) {
    return errorResponse(context, error.status, {
      error: error.message,
      code: error.code,
      retryable: error.retryable,
      retryAfterSeconds: error.retryAfterSeconds,
      fieldIssues: error.fieldIssues,
      action: error.action,
      staleReason: error.staleReason,
    });
  }
  if (error instanceof DiscordApiError) {
    if (error.status === 429) {
      const seconds = Math.ceil((error.retryAfterMs ?? 1_000) / 1_000);
      return errorResponse(context, 429, {
        error: "Discord is temporarily rate limiting this request.",
        code: "discord_rate_limited",
        retryable: true,
        retryAfterSeconds: boundRetry(seconds),
        action: "wait",
      });
    }
    if (error.status >= 500 || error.status === 408 || error.status === 0) {
      emitAdminError(context, error, "discord_unavailable", 503);
      return errorResponse(context, 503, {
        error: "Discord is temporarily unavailable.",
        code: "discord_unavailable",
        retryable: true,
        action: "retry",
      });
    }
    if (error.status === 403) {
      return errorResponse(context, 403, {
        error: "Discord denied the requested operation.",
        code: "permission_denied",
        retryable: false,
      });
    }
    if (error.status === 404) {
      return errorResponse(context, 404, {
        error: "The requested Discord resource was not found.",
        code: "resource_not_found",
        retryable: false,
      });
    }
    if (error.status === 400) {
      return errorResponse(context, 400, {
        error: "Discord rejected the requested changes.",
        code: "invalid_request",
        retryable: false,
        action: "fix_fields",
      });
    }
  }
  if (isDatabaseUnavailable(error)) {
    emitAdminError(context, error, "database_unavailable", 503);
    return errorResponse(context, 503, {
      error: "The dashboard is temporarily unavailable.",
      code: "database_unavailable",
      retryable: true,
      action: "retry",
    });
  }
  emitAdminError(context, error, "internal_error", 500);
  return errorResponse(context, 500, {
    error: "Something went wrong.",
    code: "internal_error",
    retryable: false,
    action: "contact_support",
  });
}

export async function normalizeAdminErrorResponse(
  response: Response,
  context: AdminRequestContext,
): Promise<Response> {
  if (response.status < 400) return withCorrelation(response, context.correlationId);
  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    body = null;
  }
  if (isAdminErrorEnvelope(body)) {
    return errorResponse(context, response.status, { ...body, correlationId: undefined });
  }
  const fallback = STATUS_DEFAULTS[response.status] ?? {
    code: response.status >= 500 ? ("internal_error" as const) : ("invalid_request" as const),
    message: response.status >= 500 ? "Something went wrong." : "Invalid request.",
  };
  const trustedMessage =
    response.status < 500 && isRecord(body) && typeof body.error === "string"
      ? body.error
      : fallback.message;
  const fieldIssues =
    isRecord(body) && Array.isArray(body.fieldIssues)
      ? (body.fieldIssues as AdminErrorEnvelopeV1["fieldIssues"])
      : undefined;
  const trustedCode =
    isRecord(body) &&
    typeof body.code === "string" &&
    ADMIN_ERROR_CODES.includes(body.code as AdminErrorCode)
      ? (body.code as AdminErrorCode)
      : undefined;
  const retryAfterSeconds =
    isRecord(body) && typeof body.retryAfterSeconds === "number"
      ? boundRetry(Math.ceil(body.retryAfterSeconds))
      : undefined;
  const staleReason = parseStaleReason(body);
  return errorResponse(context, response.status, {
    error: trustedMessage,
    code: fieldIssues?.some((issue) => issue.code === "invalid_json")
      ? "invalid_json"
      : (trustedCode ?? fallback.code),
    retryable: response.status === 429,
    retryAfterSeconds,
    action: response.status === 429 ? "wait" : fallback.action,
    fieldIssues,
    staleReason,
  });
}

function errorResponse(
  context: AdminRequestContext,
  status: number,
  value: Omit<AdminErrorEnvelopeV1, "correlationId"> & { correlationId?: undefined },
): Response {
  const envelope: AdminErrorEnvelopeV1 = { ...value, correlationId: context.correlationId };
  const headers = new Headers({
    "cache-control": "no-store",
    "x-correlation-id": context.correlationId,
  });
  if (envelope.retryAfterSeconds !== undefined)
    headers.set("retry-after", String(envelope.retryAfterSeconds));
  return Response.json(envelope, { status, headers });
}

function withCorrelation(response: Response, correlationId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("x-correlation-id", correlationId);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function emitAdminError(
  context: AdminRequestContext,
  cause: unknown,
  code: AdminErrorCode,
  status: number,
): void {
  reportOperationalEvent({
    severity: status >= 500 ? "error" : "warning",
    code: `admin.${code}`,
    message: `Admin request failed (${code})`,
    cause,
    correlationId: context.correlationId,
    guildId: context.guildId,
    workspaceId: context.workspaceId,
    operation: context.operationId,
    environment: context.environment,
    rayId: context.cfRay,
    context: {
      status,
      durationMs: Date.now() - context.startedAtMs,
      sentryTrace: context.sentryTrace,
    },
  });
}

function boundRetry(seconds: number): number {
  return Math.max(1, Math.min(300, seconds));
}

function parseStaleReason(body: unknown): AdminStaleReason | undefined {
  if (!isRecord(body)) return undefined;
  if (
    body.staleReason === "source" ||
    body.staleReason === "target" ||
    body.staleReason === "source_and_target"
  ) {
    return body.staleReason;
  }
  return undefined;
}
