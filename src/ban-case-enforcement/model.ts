export class EnforcementError extends Error {}
export type Action = "ban" | "unban";
export type State =
  | "pending"
  | "executing"
  | "verifying"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired"
  | "needs-attention";
export interface Intent {
  draft?: boolean;
  id: string;
  guildId: string;
  actorId: string;
  caseId: string;
  targetId: string;
  generation: number;
  targetLabel: string;
  physicalTarget: string;
  approvalIdentity: string;
  subject: string;
  action: Action;
  reason: string;
  createdAtMs: number;
  expiresAtMs: number;
}
export interface Operation extends Intent {
  state: State;
  revision: number;
  attempts: number;
  nextAtMs: number;
  confirmedAtMs: number;
  attemptAtMs: number | null;
  completedAtMs: number | null;
  transmittedAtMs: number | null;
  acknowledgedAtMs: number | null;
  outcome: string;
  before: boolean | null;
  after: boolean | null;
}
export interface Projection {
  id: string;
  token: string;
  nextAtMs: number;
  auditRequested?: boolean;
  auditOutcome?: string;
  notificationStarted?: boolean;
  notificationRevision: number;
  messageId: string | null;
}
export const REASON_LIMIT = 500;
export function validateDecision(subject: string, action: Action, reason: string) {
  if (
    !/^7656119\d{10}$/.test(subject) ||
    !["ban", "unban"].includes(action) ||
    !reason.trim() ||
    reason.length > REASON_LIMIT ||
    Array.from(reason).some((char) => char.charCodeAt(0) < 32 && char !== "\n" && char !== "\t")
  )
    throw new EnforcementError("A SteamID64 and a reason of 1–500 characters are required.");
}
export const terminal = (state: State) =>
  ["succeeded", "failed", "cancelled", "expired"].includes(state);
