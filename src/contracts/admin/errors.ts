import { z } from "zod";

export const ADMIN_ERROR_CODES = [
  "invalid_json",
  "invalid_request",
  "authentication_required",
  "permission_denied",
  "resource_not_found",
  "entitlement_required",
  "conflict",
  "stale_preview",
  "discord_rate_limited",
  "feedback_rate_limited",
  "discord_unavailable",
  "database_unavailable",
  "provider_unavailable",
  "service_unavailable",
  "request_timeout",
  "internal_error",
] as const;

export const adminErrorEnvelopeSchema = z.object({
  error: z.string(),
  code: z.enum(ADMIN_ERROR_CODES),
  correlationId: z.string(),
  retryable: z.boolean(),
  retryAfterSeconds: z.number().int().nonnegative().optional(),
  fieldIssues: z
    .array(z.object({ path: z.string(), code: z.string(), message: z.string() }))
    .optional(),
  action: z
    .enum(["sign_in", "retry", "wait", "upgrade", "contact_support", "fix_fields"])
    .optional(),
  staleReason: z.enum(["source", "target", "source_and_target"]).optional(),
});

export type AdminErrorCode = (typeof ADMIN_ERROR_CODES)[number];
export type AdminErrorEnvelopeV1 = z.infer<typeof adminErrorEnvelopeSchema>;
export type AdminFieldIssue = NonNullable<AdminErrorEnvelopeV1["fieldIssues"]>[number];
export type AdminRecoveryAction = NonNullable<AdminErrorEnvelopeV1["action"]>;
export type AdminStaleReason = NonNullable<AdminErrorEnvelopeV1["staleReason"]>;

export function isAdminErrorEnvelope(value: unknown): value is AdminErrorEnvelopeV1 {
  return adminErrorEnvelopeSchema.safeParse(value).success;
}
