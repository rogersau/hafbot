import type {
  AdminErrorCode,
  AdminFieldIssue,
  AdminRecoveryAction,
  AdminStaleReason,
} from "./admin-error-contract";

export interface AdminRouteErrorOptions {
  code: AdminErrorCode;
  status: number;
  safeMessage: string;
  retryable: boolean;
  retryAfterSeconds?: number;
  fieldIssues?: AdminFieldIssue[];
  action?: AdminRecoveryAction;
  staleReason?: AdminStaleReason;
  cause?: unknown;
}

export class AdminRouteError extends Error {
  readonly code;
  readonly status;
  readonly retryable;
  readonly retryAfterSeconds;
  readonly fieldIssues;
  readonly action;
  readonly staleReason;
  constructor(options: AdminRouteErrorOptions) {
    super(options.safeMessage, { cause: options.cause });
    this.name = "AdminRouteError";
    this.code = options.code;
    this.status = options.status;
    this.retryable = options.retryable;
    this.retryAfterSeconds = boundRetryAfter(options.retryAfterSeconds);
    this.fieldIssues = options.fieldIssues;
    this.action = options.action;
    this.staleReason = options.staleReason;
  }
}

export function boundRetryAfter(value?: number): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(1, Math.min(86_400, Math.ceil(value)));
}

export const adminRouteErrors = {
  invalidRequest: (fieldIssues?: AdminFieldIssue[]) =>
    new AdminRouteError({
      code: "invalid_request",
      status: 400,
      safeMessage: "Invalid request.",
      retryable: false,
      fieldIssues,
      action: "fix_fields",
    }),
  authenticationRequired: () =>
    new AdminRouteError({
      code: "authentication_required",
      status: 401,
      safeMessage: "Sign in to continue.",
      retryable: false,
      action: "sign_in",
    }),
  permissionDenied: () =>
    new AdminRouteError({
      code: "permission_denied",
      status: 403,
      safeMessage: "You do not have permission to perform this action.",
      retryable: false,
    }),
  entitlementRequired: () =>
    new AdminRouteError({
      code: "entitlement_required",
      status: 402,
      safeMessage: "This feature requires an upgraded plan.",
      retryable: false,
      action: "upgrade",
    }),
  notFound: () =>
    new AdminRouteError({
      code: "resource_not_found",
      status: 404,
      safeMessage: "Not found.",
      retryable: false,
    }),
  discordRateLimited: (seconds: number, cause?: unknown) =>
    new AdminRouteError({
      code: "discord_rate_limited",
      status: 429,
      safeMessage: "Discord is temporarily rate limiting this request.",
      retryable: true,
      retryAfterSeconds: seconds,
      action: "wait",
      cause,
    }),
  discordUnavailable: (cause?: unknown) =>
    new AdminRouteError({
      code: "discord_unavailable",
      status: 503,
      safeMessage: "Discord is temporarily unavailable.",
      retryable: true,
      action: "retry",
      cause,
    }),
  databaseUnavailable: (cause?: unknown) =>
    new AdminRouteError({
      code: "database_unavailable",
      status: 503,
      safeMessage: "The dashboard is temporarily unavailable.",
      retryable: true,
      action: "retry",
      cause,
    }),
  providerUnavailable: (cause?: unknown) =>
    new AdminRouteError({
      code: "provider_unavailable",
      status: 503,
      safeMessage: "A required provider is temporarily unavailable.",
      retryable: true,
      action: "retry",
      cause,
    }),
};
