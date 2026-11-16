import type { AdminErrorCode, AdminErrorEnvelopeV1 } from "../../src/contracts/admin/errors";

/** An explicit current API response for dashboard network fixtures. */
export function adminErrorResponse(
  error: string,
  status: number,
  fields: Partial<Omit<AdminErrorEnvelopeV1, "error">> = {},
) {
  const codes: Record<number, AdminErrorCode> = {
    400: "invalid_request",
    401: "authentication_required",
    403: "permission_denied",
    404: "resource_not_found",
    409: "conflict",
    429: "discord_rate_limited",
    503: "service_unavailable",
  };
  return Response.json(
    {
      error,
      code: codes[status] ?? "internal_error",
      correlationId: "test-correlation",
      retryable: status === 429,
      ...fields,
    },
    { status },
  );
}
