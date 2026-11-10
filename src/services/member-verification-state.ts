import type { MemberVerificationAttempt } from "../types";

// Trust survives role removal. Role presence alone may backfill trust, but a failed
// role grant must never manufacture it. Eligibility remains owned by the service.
export type VerificationMemberState =
  | "unverified"
  | "role-only"
  | "remembered-role-missing"
  | "verified";

export function verificationMemberState(
  remembered: boolean,
  hasRole: boolean,
): VerificationMemberState {
  if (remembered) return hasRole ? "verified" : "remembered-role-missing";
  return hasRole ? "role-only" : "unverified";
}

export type VerificationAttemptState = "available" | "consumed" | "expired";

export function verificationAttemptState(
  attempt: Pick<MemberVerificationAttempt, "usedAtMs" | "expiresAtMs">,
  nowMs: number,
): VerificationAttemptState {
  // Consumption is terminal even after the original expiry deadline.
  if (attempt.usedAtMs !== null) return "consumed";
  return attempt.expiresAtMs <= nowMs ? "expired" : "available";
}
