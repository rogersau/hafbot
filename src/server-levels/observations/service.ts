import {
  OBSERVATION_POLICY,
  ObservationError,
  emptyTotals,
  observationMemberKey,
  type Observation,
  type ObservationRun,
} from "./model";
import type { ObservationStore } from "./store";
import type { ReadResults } from "../../wardogs/model";
import { WardogsError } from "../../wardogs/model";
import { SafeDiagnosticError } from "../../observability/safe-diagnostic-error";
import type {
  PlatformLinkIdentityReader,
  PlatformIdentityAssurance,
} from "../../services/platform-link-identity-reader";
export interface ObservationProvider {
  readiness(
    guildId: string,
    targetId: string,
  ): Promise<{ ready: boolean; authorized?: boolean; generation: number; completeRoster: boolean }>;
  status(run: ObservationRun, guard: ObservationReadGuard): Promise<ReadResults["status"]>;
  roster(run: ObservationRun, guard: ObservationReadGuard): Promise<ReadResults["roster"]>;
}
export interface ObservationReadGuard {
  beforeSend(dispatchByMs: number): Promise<void>;
  onSend(startedAtMs: number): void;
}
export interface ObservationOptions {
  store: ObservationStore;
  provider: ObservationProvider;
  identities: PlatformLinkIdentityReader;
  eligible(guildId: string): Promise<boolean>;
  owner(guildId: string, steamId: string): Promise<string | null>;
  member(guildId: string, userId: string): Promise<boolean>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}
export class AttendanceObservationService {
  private now: () => number;
  private wait: (ms: number) => Promise<void>;
  constructor(private options: ObservationOptions) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  async readiness(guildId: string, targetId: string) {
    const target = await this.options.provider.readiness(guildId, targetId);
    return {
      ...target,
      ready: target.ready && (await this.options.eligible(guildId)),
      label: "Observation only — no XP",
      maxHours: 24,
      intervalSeconds: 60,
    };
  }
  async start(input: {
    guildId: string;
    targetId: string;
    generation: number;
    actorId: string;
    durationHours: number;
    configuredCapacity: number | null;
    evidence: ObservationRun["evidence"];
    confirmation: "OBSERVATION_ONLY_NO_XP";
  }) {
    if (
      input.confirmation !== "OBSERVATION_ONLY_NO_XP" ||
      !input.actorId ||
      !Number.isFinite(input.durationHours) ||
      !Number.isSafeInteger(input.durationHours * 3600000) ||
      input.durationHours <= 0 ||
      input.durationHours > 24
    )
      throw new ObservationError(
        "Explicit observation-only consent for at most 24 hours is required.",
      );
    if (
      input.configuredCapacity !== null &&
      (!Number.isSafeInteger(input.configuredCapacity) ||
        input.configuredCapacity < 1 ||
        input.configuredCapacity > 10000)
    )
      throw new ObservationError("Capacity must be an explicit admin reference value.");
    if (
      !/^[a-f0-9]{40}$/.test(input.evidence.sourceRevision) ||
      /\d{17,}/.test(input.evidence.sourceRevision) ||
      !["synthetic-fixture", "operator-read-approved"].includes(input.evidence.hostEvidence) ||
      (input.evidence.serverBuild !== null &&
        (!/^[A-Za-z0-9._-]{1,100}$/.test(input.evidence.serverBuild) ||
          /\d{17,}/.test(input.evidence.serverBuild)))
    )
      throw new ObservationError(
        "Use a source revision, a non-identifying build label and approved-host evidence classification.",
      );
    const ready = await this.readiness(input.guildId, input.targetId);
    if (!ready.ready || ready.generation !== input.generation)
      throw new ObservationError(
        "Observation requires paid Server Levels eligibility, Steam linking, scheduled processing and a verified read-approved target.",
      );
    const now = this.now();
    const active = (await this.options.store.list(input.guildId)).find(
      (r) => r.targetId === input.targetId && r.state === "running",
    );
    if (active && active.expiresAtMs <= now) await this.stop(input.guildId, active.id, "expired");
    return this.options.store.start({
      id: crypto.randomUUID(),
      guildId: input.guildId,
      targetId: input.targetId,
      generation: input.generation,
      actorId: input.actorId,
      createdAtMs: now,
      expiresAtMs: now + input.durationHours * 3600000,
      deleteAtMs: now + OBSERVATION_POLICY.retentionMs,
      stoppedAtMs: null,
      state: "running",
      stopReason: null,
      nextAtMs: now,
      revision: 1,
      lease: null,
      slot: null,
      configuredCapacity: input.configuredCapacity,
      evidence: input.evidence,
      totals: emptyTotals(),
    });
  }
  async stop(guildId: string, id: string, reason = "admin_stopped") {
    for (let i = 0; i < 3; i++) {
      const run = await this.options.store.read(id);
      if (!run || run.guildId !== guildId)
        throw new ObservationError("Observation run unavailable.");
      if (run.state === "stopped") return run;
      const saved = await this.options.store.stop(run, this.now(), reason);
      if (saved) return saved;
    }
    throw new ObservationError("Run changed concurrently. Retry stop.");
  }
  async eraseMember(guildId: string, userId: string) {
    // Any in-flight read may contain this member. Stop the bounded set of active
    // Guild experiments so an old result cannot recreate their erased sample.
    for (const run of (await this.options.store.list(guildId)).filter(
      (run) => run.state === "running",
    ))
      await this.stop(guildId, run.id, "personal_erasure");
    await this.options.store.eraseMember(
      guildId,
      userId,
      await observationMemberKey(guildId, userId),
    );
  }
  private async current(run: ObservationRun, requireReady = true) {
    const saved = await this.options.store.read(run.id);
    const target = await this.options.provider.readiness(run.guildId, run.targetId);
    return Boolean(
      saved &&
      saved.state === "running" &&
      saved.revision === run.revision &&
      saved.lease === run.lease &&
      saved.expiresAtMs > this.now() &&
      (requireReady ? target.ready : (target.authorized ?? target.ready)) &&
      target.generation === run.generation &&
      (await this.options.eligible(run.guildId)),
    );
  }
  async processDue() {
    try {
      return await this.processDueSafely();
    } catch (cause) {
      throw new ObservationError("Attendance observation processing unavailable.", { cause });
    }
  }
  private async processDueSafely() {
    // Stages are fixed application wording, never provider or store error details.
    let stage = "cleanup";
    try {
      await this.options.store.cleanup(this.now());
      stage = "due_listing";
      const due = await this.options.store.due(this.now());
      for (const candidate of due) {
        if (candidate.expiresAtMs <= this.now()) {
          stage = "expired_stop";
          await this.stop(candidate.guildId, candidate.id, "expired");
          continue;
        }
        stage = "readiness";
        const ready = await this.readiness(candidate.guildId, candidate.targetId);
        if (!ready.ready || ready.generation !== candidate.generation) {
          stage = "readiness_stop";
          await this.stop(candidate.guildId, candidate.id, "readiness_lost");
          continue;
        }
        stage = "claim";
        const run = await this.options.store.claim(candidate, this.now());
        if (!run) continue;
        stage = "sample";
        try {
          await this.sample(run, ready.completeRoster);
        } catch (sampleCause) {
          try {
            stage = "sample_recovery_read";
            const current = await this.options.store.read(run.id);
            if (current?.state === "running" && current.revision === run.revision) {
              stage = "sample_recovery_stop";
              await this.stop(run.guildId, run.id, "validation_unavailable");
            }
          } catch (recoveryCause) {
            // Retain the sample failure even when its recovery also fails.
            throw new AggregateError(
              [
                new SafeDiagnosticError("Attendance observation sample failed.", {
                  cause: sampleCause,
                }),
                recoveryCause,
              ],
              "Attendance observation sample recovery failed.",
            );
          }
        }
      }
      return due.length;
    } catch (cause) {
      throw new SafeDiagnosticError(`Attendance observation ${stage} failed.`, { cause });
    }
  }
  private async sample(run: ObservationRun, completeRoster: boolean) {
    if (!(await this.current(run))) {
      await this.options.store.late(run.id);
      return;
    }
    let statusStarted = this.now();
    let statusSent = false;
    let statusDispatchBy = 0;
    const readGuard = (firstRead: boolean, onSend: (at: number) => void): ObservationReadGuard => {
      let dispatchBy = 0;
      return {
        beforeSend: async (latestStart) => {
          if (!(await this.current(run))) throw new WardogsError("disabled");
          dispatchBy = Math.min(latestStart, run.nextAtMs - 1, run.expiresAtMs - 1);
          if (!(await this.options.store.guardRead(run, this.now(), dispatchBy, firstRead)))
            throw new WardogsError("disabled");
          if (firstRead) statusDispatchBy = dispatchBy;
        },
        onSend: (at) => {
          if (at > dispatchBy) throw new WardogsError("timeout");
          onSend(at);
        },
      };
    };
    let status: ReadResults["status"] | null = null;
    let roster: ReadResults["roster"] | null = null;
    let statusError: string | null = null;
    let rosterError: string | null = null;
    let retryAt = 0;
    try {
      status = await this.options.provider.status(
        run,
        readGuard(true, (at) => {
          statusStarted = at;
          statusSent = true;
        }),
      );
    } catch (error) {
      statusError = error instanceof WardogsError ? error.code : "provider_unavailable";
      retryAt = error instanceof WardogsError ? (error.retryAtMs ?? 0) : 0;
    } finally {
      if (statusSent)
        await this.options.store.recordReadStart(run, statusStarted, statusDispatchBy);
    }
    const statusFinished = this.now();
    await this.wait(5000);
    if (!(await this.current(run, false))) {
      await this.options.store.late(run.id);
      const latest = await this.options.store.read(run.id);
      if (latest?.state === "running" && latest.revision === run.revision)
        await this.stop(run.guildId, run.id, "readiness_lost");
      return;
    }
    let rosterStarted = this.now();
    let requestCount = 1;
    try {
      if (statusSent && (await this.current(run))) {
        requestCount++;
        roster = await this.options.provider.roster(
          run,
          readGuard(false, (at) => {
            rosterStarted = at;
          }),
        );
      } else rosterError = "readiness_lost";
    } catch (error) {
      rosterError = error instanceof WardogsError ? error.code : "provider_unavailable";
      retryAt = Math.max(retryAt, error instanceof WardogsError ? (error.retryAtMs ?? 0) : 0);
    }
    const rosterFinished = this.now();
    const linkedSubjects: Observation["linkedSubjects"] = [];
    const checked = new Map<string, boolean>();
    let identityCoverage: Observation["identityCoverage"] = "complete";
    for (const player of roster?.players ?? []) {
      const user = await this.options.owner(run.guildId, player.steamId);
      if (!user) continue;
      if (!checked.has(user)) {
        if (checked.size >= OBSERVATION_POLICY.maxLinkedMembers) {
          identityCoverage = "partial";
          continue;
        }
        checked.set(user, await this.options.member(run.guildId, user));
      }
      if (!checked.get(user)) continue;
      const identity = await this.options.identities.readIdentity(
        run.guildId,
        user,
        "steam",
        player.steamId,
      );
      if (
        identity?.active &&
        identity.guildId === run.guildId &&
        identity.userId === user &&
        identity.platformId === player.steamId &&
        ["authenticated", "administrative"].includes(identity.assurance)
      )
        linkedSubjects.push({
          steamId: player.steamId,
          assurance: identity.assurance as PlatformIdentityAssurance,
          memberKey: await observationMemberKey(run.guildId, user),
        });
    }
    if (!(await this.current(run, false))) {
      await this.options.store.late(run.id);
      return;
    }
    const previous = (await this.options.store.samples(run.id, this.now())).at(-1);
    const sample: Observation = {
      id: `${run.id}:${run.slot}`,
      runId: run.id,
      guildId: run.guildId,
      targetId: run.targetId,
      generation: run.generation,
      slot: run.slot!,
      observedAtMs: rosterFinished,
      status: {
        startedAtMs: statusStarted,
        finishedAtMs: statusFinished,
        population: status?.players.current ?? null,
        capacity: status?.players.max ?? null,
        error: statusError,
      },
      roster: {
        startedAtMs: rosterStarted,
        finishedAtMs: rosterFinished,
        count: roster?.players.length ?? null,
        completeness: roster && completeRoster ? "complete" : "unknown",
        error: rosterError,
      },
      linkedSubjects,
      identityCoverage,
      queue: { state: "unknown", count: null },
      continuity: { state: "unknown", sessionId: null },
      countDisagreement: Boolean(
        status && roster && status.players.current !== roster.players.length,
      ),
      capacityMismatch: Boolean(
        status && run.configuredCapacity !== null && status.players.max !== run.configuredCapacity,
      ),
      matchSeconds: status?.matchSeconds ?? null,
      map: status?.map ?? null,
      possibleMatchBoundary: Boolean(
        status &&
        previous &&
        ((status.map !== undefined && previous.map !== null && status.map !== previous.map) ||
          (status.matchSeconds !== undefined &&
            previous.matchSeconds !== null &&
            status.matchSeconds < previous.matchSeconds)),
      ),
    };
    const contiguous =
      previous &&
      previous.slot === sample.slot - 1 &&
      previous.roster.completeness === "complete" &&
      sample.roster.completeness === "complete" &&
      previous.identityCoverage === "complete" &&
      identityCoverage === "complete";
    const before = new Set(previous?.linkedSubjects.map((s) => s.steamId));
    const after = new Set(linkedSubjects.map((s) => s.steamId));
    const next = {
      ...run,
      nextAtMs: Math.max(run.nextAtMs, retryAt),
      totals: {
        ...run.totals,
        samples: run.totals.samples + 1,
        failed: run.totals.failed + Number(!status || !roster),
        disagreements: run.totals.disagreements + Number(sample.countDisagreement),
        capacityMismatches: run.totals.capacityMismatches + Number(sample.capacityMismatch),
        completeRosters:
          run.totals.completeRosters + Number(sample.roster.completeness === "complete"),
        apparentArrivals:
          run.totals.apparentArrivals +
          (contiguous ? [...after].filter((id) => !before.has(id)).length : 0),
        apparentDepartures:
          run.totals.apparentDepartures +
          (contiguous ? [...before].filter((id) => !after.has(id)).length : 0),
        possibleMatchBoundaries:
          run.totals.possibleMatchBoundaries + Number(sample.possibleMatchBoundary),
        requestCount: run.totals.requestCount + requestCount,
        requestMs:
          run.totals.requestMs +
          (statusFinished - statusStarted) +
          (rosterFinished - rosterStarted),
      },
    };
    await this.options.store.finish(next, sample, this.now(), retryAt);
  }
}
