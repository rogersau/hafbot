import type {
  AdminErrorCode,
  AdminFieldIssue,
  AdminRecoveryAction,
  AdminStaleReason,
} from "../../contracts/admin/errors";
import { adminErrorEnvelopeSchema } from "../../contracts/admin/errors";

export class AdminApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: AdminErrorCode | "legacy_error",
    readonly correlationId: string,
    readonly retryable: boolean,
    readonly retryAfterSeconds?: number,
    readonly fieldIssues?: AdminFieldIssue[],
    readonly action?: AdminRecoveryAction,
    readonly staleReason?: AdminStaleReason,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

export async function readJsonOrThrow<T>(input: RequestInfo | URL, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  if (!response.ok) {
    throw await parseAdminApiError(response, `${response.status} ${response.statusText}`);
  }

  return response.json() as Promise<T>;
}

export function describeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "Unexpected dashboard error";
  }

  if (error.message.includes("Discord OAuth access token")) {
    return "Please sign out and sign back in with Discord to grant server-list access.";
  }

  return looksLikeHtmlError(error.message) ? "Discord lookup failed right now." : error.message;
}

export function looksLikeHtmlError(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("<!doctype html") || normalized.startsWith("<html");
}

export function combineDashboardErrors(...errors: Array<string | null>): string | null {
  const combined = errors.filter((error): error is string => Boolean(error)).join(" ");
  return combined.length > 0 ? combined : null;
}

export function formatHeartbeatInterval(intervalMs: number | null): string {
  if (intervalMs === null) {
    return "Unknown";
  }

  return `${Math.round(intervalMs / 1000)}s`;
}

export function buildWorkspaceGuildPath(
  path: string,
  workspaceId: string,
  guildId: string,
): string {
  const params = new URLSearchParams({ guildId });
  if (workspaceId.trim()) params.set("workspaceId", workspaceId.trim());
  return `${path}?${params.toString()}`;
}

export async function readResponseError(response: Response, fallback: string): Promise<string> {
  try {
    return (await parseAdminApiError(response, fallback)).message;
  } catch {
    return fallback;
  }
}

export async function parseAdminApiError(
  response: Response,
  fallback: string,
): Promise<AdminApiError> {
  const correlationHeader = response.headers.get("x-correlation-id") ?? "unknown";
  const raw = await response.text();
  let body: Record<string, unknown> | null = null;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    /* legacy text */
  }
  const envelope = adminErrorEnvelopeSchema.safeParse(body);
  if (envelope.success) {
    return new AdminApiError(
      envelope.data.error,
      response.status,
      envelope.data.code,
      envelope.data.correlationId,
      envelope.data.retryable,
      envelope.data.retryAfterSeconds,
      envelope.data.fieldIssues,
      envelope.data.action,
      envelope.data.staleReason,
    );
  }
  const message =
    body && typeof body.error === "string"
      ? body.error
      : raw
        ? describeError(new Error(raw))
        : fallback;
  return new AdminApiError(message, response.status, "legacy_error", correlationHeader, false);
}

export const isAuthenticationError = (error: unknown): error is AdminApiError =>
  error instanceof AdminApiError && error.code === "authentication_required";
export const isRetryableAdminError = (error: unknown): error is AdminApiError =>
  error instanceof AdminApiError && error.retryable;
export function fieldIssuesFor(error: AdminApiError, path: string): AdminFieldIssue[] {
  return error.fieldIssues?.filter((issue) => issue.path === path) ?? [];
}
