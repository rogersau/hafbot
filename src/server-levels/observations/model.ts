import type { PlatformIdentityAssurance } from "../../services/platform-link-identity-reader";
export const OBSERVATION_POLICY = {
  intervalMs: 60_000,
  maxDurationMs: 86_400_000,
  retentionMs: 604_800_000,
  maxRunsPerSweep: 5,
  maxLinkedMembers: 50,
} as const;
export class ObservationError extends Error {}
export interface Observation {
  id: string;
  runId: string;
  guildId: string;
  targetId: string;
  generation: number;
  slot: number;
  observedAtMs: number;
  status: {
    startedAtMs: number;
    finishedAtMs: number;
    population: number | null;
    capacity: number | null;
    error: string | null;
  };
  roster: {
    startedAtMs: number;
    finishedAtMs: number;
    count: number | null;
    completeness: "complete" | "unknown";
    error: string | null;
  };
  linkedSubjects: { steamId: string; assurance: PlatformIdentityAssurance; memberKey: string }[];
  identityCoverage: "complete" | "partial";
  queue: { state: "unknown"; count: null };
  continuity: { state: "unknown"; sessionId: null };
  countDisagreement: boolean;
  capacityMismatch: boolean;
  matchSeconds: number | null;
  map: string | null;
  possibleMatchBoundary: boolean;
}
export interface ObservationRun {
  id: string;
  guildId: string;
  targetId: string;
  generation: number;
  actorId: string | null;
  createdAtMs: number;
  expiresAtMs: number;
  deleteAtMs: number;
  stoppedAtMs: number | null;
  state: "running" | "stopped";
  stopReason: string | null;
  nextAtMs: number;
  revision: number;
  lease: string | null;
  slot: number | null;
  configuredCapacity: number | null;
  evidence: { sourceRevision: string; serverBuild: string | null; hostEvidence: string };
  totals: {
    attempts: number;
    samples: number;
    failed: number;
    missingSlots: number;
    disagreements: number;
    capacityMismatches: number;
    completeRosters: number;
    queueKnown: number;
    apparentArrivals: number;
    apparentDepartures: number;
    possibleMatchBoundaries: number;
    requestCount: number;
    requestMs: number;
  };
}
export function emptyTotals(): ObservationRun["totals"] {
  return {
    attempts: 0,
    samples: 0,
    failed: 0,
    missingSlots: 0,
    disagreements: 0,
    capacityMismatches: 0,
    completeRosters: 0,
    queueKnown: 0,
    apparentArrivals: 0,
    apparentDepartures: 0,
    possibleMatchBoundaries: 0,
    requestCount: 0,
    requestMs: 0,
  };
}
export function redactedReport(run: ObservationRun, duplicates = 0, late = 0) {
  return {
    reportId: run.id,
    coverage: {
      plannedSlots: Math.ceil((run.expiresAtMs - run.createdAtMs) / 60_000),
      completedSamples: run.totals.samples,
      completeReadPairs: run.totals.samples - run.totals.failed,
    },
    label: "Observation only — no XP",
    decision: "NO_GO" as const,
    policyVersion: 1,
    startedAtMs: run.createdAtMs,
    endedAtMs: run.stoppedAtMs,
    expiresAtMs: run.expiresAtMs,
    state: run.state,
    stopReason: run.stopReason,
    evidence: run.evidence,
    totals: {
      ...run.totals,
      duplicatesIgnored: duplicates,
      lateResultsDiscarded: late,
      unfinishedSamples: Math.max(0, run.totals.attempts - run.totals.samples),
    },
    configuredCapacity: run.configuredCapacity,
    queue: "unknown",
    continuity: "unknown",
    requestCadenceMs: OBSERVATION_POLICY.intervalMs,
    measuredRequestTimeMs: run.totals.requestMs,
    cost: "Read attempts, including local throttling, and elapsed attempt time only; billing and CPU cost not measured.",
    limitations: [
      "Point-in-time presence does not establish joins, leaves or continuous attendance.",
      "Status and roster are separate, non-atomic reads.",
      "Missing samples are unknown time; no backfill.",
      "Match resets do not prove server restarts.",
      "Link or membership changes can change apparent linked-subject transitions.",
      "Queue and stable sessions require a supported provider contract.",
      "No XP, earning sessions, rewards or paid access are created; observations cannot be converted into retroactive awards.",
    ],
  };
}

// Private, Guild-scoped erasure lookup survives deleted Platform Links without
// storing a member's raw Discord ID in attendance samples. Never expose it in reports.
export async function observationMemberKey(guildId: string, userId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${guildId}\0${userId}`),
  );
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
