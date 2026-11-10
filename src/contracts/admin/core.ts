import type { z } from "zod";
import { adminErrorEnvelopeSchema, type AdminErrorCode } from "./errors";

export const ADMIN_OPERATION_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

export type AdminOperationMethod = (typeof ADMIN_OPERATION_METHODS)[number];
export type AdminApiTag = string;
export type AdminContractAccessMetadata = {
  mode: "read" | "write";
  scope: "customer" | "guild" | "workspace";
};

export interface AdminOperationErrorSpec {
  status: 400 | 401 | 402 | 403 | 404 | 409 | 429 | 500 | 503;
  codes: readonly AdminErrorCode[];
  description: string;
  schema: typeof adminErrorEnvelopeSchema;
}

export interface AdminOperationContract<
  TPath extends string = string,
  TQuery extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined,
  TBody extends z.ZodTypeAny | undefined = z.ZodTypeAny | undefined,
  TSuccess extends z.ZodTypeAny = z.ZodTypeAny,
> {
  operationId: string;
  method: AdminOperationMethod;
  path: TPath;
  summary: string;
  description?: string;
  tags: readonly AdminApiTag[];
  query?: TQuery;
  body?: TBody;
  success: {
    status: 200 | 201 | 202;
    schema: TSuccess;
    description: string;
  };
  errors: readonly AdminOperationErrorSpec[];
  access: AdminContractAccessMetadata;
  feature: string | undefined;
  entitlement: string | undefined;
}

export function defineAdminOperation<
  TPath extends string,
  TQuery extends z.ZodTypeAny | undefined,
  TBody extends z.ZodTypeAny | undefined,
  TSuccess extends z.ZodTypeAny,
>(
  contract: AdminOperationContract<TPath, TQuery, TBody, TSuccess>,
): AdminOperationContract<TPath, TQuery, TBody, TSuccess> {
  return contract;
}

function error(
  status: AdminOperationErrorSpec["status"],
  codes: readonly AdminErrorCode[],
  description: string,
): AdminOperationErrorSpec {
  return { status, codes, description, schema: adminErrorEnvelopeSchema };
}

export const adminOperationErrors = {
  invalidRequest: error(400, ["invalid_json", "invalid_request"], "The request is invalid"),
  authenticationRequired: error(401, ["authentication_required"], "Authentication is required"),
  entitlementRequired: error(
    402,
    ["entitlement_required"],
    "The Guild entitlement is insufficient",
  ),
  permissionDenied: error(403, ["permission_denied"], "The actor lacks permission"),
  resourceNotFound: error(404, ["resource_not_found"], "The requested resource was not found"),
  conflict: error(409, ["conflict"], "The request conflicts with current state"),
  discordRateLimited: error(429, ["discord_rate_limited"], "Discord is rate limiting requests"),
  feedbackRateLimited: error(
    429,
    ["feedback_rate_limited"],
    "The feedback submission limit was reached",
  ),
  unavailable: error(
    503,
    [
      "discord_unavailable",
      "database_unavailable",
      "provider_unavailable",
      "service_unavailable",
      "request_timeout",
    ],
    "A required service is unavailable",
  ),
  internal: error(500, ["internal_error"], "An unexpected internal error occurred"),
} as const;

export function validateAdminOperationContracts(
  contracts: readonly AdminOperationContract[],
): void {
  const operationIds = new Set<string>();
  const routes = new Set<string>();
  let previousOperationId: string | undefined;

  for (const contract of contracts) {
    if (!/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/.test(contract.operationId)) {
      throw new Error(`Invalid admin operation ID: ${contract.operationId}`);
    }
    if (operationIds.has(contract.operationId)) {
      throw new Error(`Duplicate admin operation ID: ${contract.operationId}`);
    }
    if (previousOperationId !== undefined && previousOperationId > contract.operationId) {
      throw new Error(
        `Admin operation registry is not sorted: ${previousOperationId} precedes ${contract.operationId}`,
      );
    }
    if (!ADMIN_OPERATION_METHODS.includes(contract.method)) {
      throw new Error(`Invalid admin operation method: ${String(contract.method)}`);
    }
    if (!/^\/admin\/api(?:\/[A-Za-z0-9._~:-]+)*$/.test(contract.path)) {
      throw new Error(`Invalid admin operation path: ${contract.path}`);
    }
    const route = `${contract.method} ${contract.path}`;
    if (routes.has(route)) throw new Error(`Duplicate admin operation route: ${route}`);
    if (
      !contract.summary.trim() ||
      contract.tags.length === 0 ||
      contract.tags.some((tag) => !tag.trim()) ||
      !contract.success.description.trim() ||
      !Object.hasOwn(contract, "feature") ||
      !Object.hasOwn(contract, "entitlement")
    ) {
      throw new Error(`Incomplete admin operation metadata: ${contract.operationId}`);
    }
    if (
      contract.errors.length === 0 ||
      contract.errors.some((spec) => spec.codes.length === 0 || !spec.description.trim())
    ) {
      throw new Error(`Admin operation has no declared errors: ${contract.operationId}`);
    }
    if (contract.errors.some((spec) => spec.schema !== adminErrorEnvelopeSchema)) {
      throw new Error(`Admin operation uses a non-canonical error schema: ${contract.operationId}`);
    }

    operationIds.add(contract.operationId);
    routes.add(route);
    previousOperationId = contract.operationId;
  }
}
