import { type ObservationRun, type Observation } from "./model";

export interface ObservationStore {
  read: (id: string) => Promise<ObservationRun | null>;
  samples: (id: string, now: number) => Promise<Observation[]>;
  reports(guildId: string): Promise<
    {
      reportId: string;
      coverage: {
        plannedSlots: number;
        completedSamples: number;
        completeReadPairs: number;
      };
      label: string;
      decision: "NO_GO";
      policyVersion: number;
      startedAtMs: number;
      endedAtMs: number | null;
      expiresAtMs: number;
      state: "running" | "stopped";
      stopReason: string | null;
      evidence: {
        sourceRevision: string;
        serverBuild: string | null;
        hostEvidence: string;
      };
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
        duplicatesIgnored: number;
        lateResultsDiscarded: number;
        unfinishedSamples: number;
      };
      configuredCapacity: number | null;
      queue: string;
      continuity: string;
      requestCadenceMs: 60000;
      measuredRequestTimeMs: number;
      cost: string;
      limitations: string[];
    }[]
  >;
  list(guildId: string): Promise<ObservationRun[]>;
  start(run: ObservationRun): Promise<ObservationRun>;
  due(now: number): Promise<ObservationRun[]>;
  claim(
    run: ObservationRun,
    now: number,
  ): Promise<{
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
    configuredCapacity: number | null;
    evidence: {
      sourceRevision: string;
      serverBuild: string | null;
      hostEvidence: string;
    };
    revision: number;
    lease: `${string}-${string}-${string}-${string}-${string}`;
    slot: number;
    nextAtMs: number;
    totals: {
      samples: number;
      failed: number;
      disagreements: number;
      capacityMismatches: number;
      completeRosters: number;
      queueKnown: number;
      apparentArrivals: number;
      apparentDepartures: number;
      possibleMatchBoundaries: number;
      requestCount: number;
      requestMs: number;
      attempts: number;
      missingSlots: number;
    };
  } | null>;
  guardRead(
    run: ObservationRun,
    now: number,
    dispatchByMs: number,
    firstRead: boolean,
  ): Promise<boolean>;
  recordReadStart(run: ObservationRun, startedAtMs: number, dispatchByMs: number): Promise<void>;
  finish(run: ObservationRun, sample: Observation, now: number, retryAt?: number): Promise<boolean>;
  stop(
    run: ObservationRun,
    now: number,
    reason: string,
  ): Promise<{
    id: string;
    guildId: string;
    targetId: string;
    generation: number;
    actorId: string | null;
    createdAtMs: number;
    expiresAtMs: number;
    deleteAtMs: number;
    nextAtMs: number;
    slot: number | null;
    configuredCapacity: number | null;
    evidence: {
      sourceRevision: string;
      serverBuild: string | null;
      hostEvidence: string;
    };
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
    state: "stopped";
    stoppedAtMs: number;
    stopReason: string;
    revision: number;
    lease: null;
  } | null>;
  late(id: string): Promise<void>;
  report(id: string): Promise<{
    reportId: string;
    coverage: {
      plannedSlots: number;
      completedSamples: number;
      completeReadPairs: number;
    };
    label: string;
    decision: "NO_GO";
    policyVersion: number;
    startedAtMs: number;
    endedAtMs: number | null;
    expiresAtMs: number;
    state: "running" | "stopped";
    stopReason: string | null;
    evidence: {
      sourceRevision: string;
      serverBuild: string | null;
      hostEvidence: string;
    };
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
      duplicatesIgnored: number;
      lateResultsDiscarded: number;
      unfinishedSamples: number;
    };
    configuredCapacity: number | null;
    queue: string;
    continuity: string;
    requestCadenceMs: 60000;
    measuredRequestTimeMs: number;
    cost: string;
    limitations: string[];
  } | null>;
  cleanup(now: number): Promise<void>;
  eraseMember(guildId: string, userId: string, memberKey: string): Promise<void>;
  eraseGuild(guildId: string): Promise<void>;
}
