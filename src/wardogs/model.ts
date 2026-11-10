import type { StoredCredentialEnvelopeV1 } from "../security/webhook-credentials";

export const WARDOGS_POLICY = Object.freeze({
  maxTargets: 5,
  timeoutMs: 5_000,
  maxResponseBytes: 256 * 1024,
  maxRosterRows: 512,
  maxCapabilityRoutes: 128,
  requestsPerMinute: 12,
});
export const READ_ROUTES = {
  capabilities: "/v1/capabilities",
  status: "/v1/status",
  roster: "/v1/players",
} as const;
export type ReadOperation = keyof typeof READ_ROUTES;
export type Failure =
  | "disabled"
  | "unapproved_target"
  | "unreachable"
  | "timeout"
  | "tls_error"
  | "authentication_failed"
  | "forbidden"
  | "unsupported_operation"
  | "rate_limited"
  | "invalid_response"
  | "oversized_response"
  | "provider_unavailable";
export class WardogsError extends Error {
  constructor(
    readonly code: Failure,
    readonly retryAtMs: number | null = null,
  ) {
    super(`WARDOGS read failed: ${code.replaceAll("_", " ")}.`);
    this.name = "WardogsError";
  }
}
// Proof of local rejection before entering the mutation transport, scoped to that attempt.
// Never classify transport timeouts or HTTP responses as pre-dispatch failures.
export class WardogsPreDispatchError extends WardogsError {}
export interface ReadResults {
  capabilities: { routes: ReadOperation[] };
  status: {
    players: { current: number; max: number };
    queue: null;
    serverName?: string;
    map?: string;
    matchSeconds?: number;
  };
  roster: { players: { steamId: string }[] };
}
export interface Target {
  id: string;
  guildId: string;
  name: string;
  originRef: string | null;
  generation: number;
  enabled: boolean;
  commerceEnabled?: boolean;
  banCasesEnabled?: boolean;
  disconnected: boolean;
  credentialId: string | null;
  envelope: StoredCredentialEnvelopeV1 | null;
  credentialUpdatedAtMs: number | null;
  createdAtMs: number;
  updatedAtMs: number;
  diagnostic: Failure | null;
  authBlocked: boolean;
  verifiedOrigin: string | null;
  verifiedGeneration: number | null;
  verifiedAtMs: number | null;
  lastSuccessAtMs: number | null;
}
export type PublicTarget = Omit<Target, "envelope" | "credentialId" | "verifiedOrigin"> & {
  credentialConfigured: boolean;
  stale: boolean;
};
export function publicTarget(target: Target): PublicTarget {
  const { envelope, credentialId: _id, verifiedOrigin: _origin, ...safe } = target;
  return {
    ...safe,
    credentialConfigured: envelope !== null,
    stale:
      target.verifiedGeneration !== target.generation ||
      target.verifiedOrigin === null ||
      target.diagnostic !== null,
  };
}
export interface ApprovedOrigin {
  id: string;
  origin: string;
  // Operator attestation of fixed endpoint ownership and the entire upstream path.
  securePathEvidence: string;
  runtime: "cloudflare" | "portable";
}
export interface NetworkPolicy {
  enabled: boolean;
  origins: readonly ApprovedOrigin[];
  approvals: readonly {
    targetId: string;
    generation: number;
    originRef: string;
    origin: string;
    // Evidence that this exact generation returns full roster snapshots, not pages.
    attendanceContract?: { completeRoster: boolean; evidence: string };
    reservedContract?: {
      physicalTargetId: string;
      evidence: string;
      completeList: true;
      capacityMeaning: "saleable-entries";
      entryCapacity: number;
    };
    banContract?: {
      physicalTargetId: string;
      evidence: string;
      completeList: true;
      synchronousMutations: true;
      ban: boolean;
      unban: boolean;
    };
  }[];
}
export const DISABLED_NETWORK: NetworkPolicy = Object.freeze({
  enabled: false,
  origins: [],
  approvals: [],
});
