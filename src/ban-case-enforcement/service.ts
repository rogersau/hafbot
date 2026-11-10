import type { BanCaseStore } from "../runtime/contracts/ban-case-store";
import { WARDOGS_POLICY, WardogsError, WardogsPreDispatchError } from "../wardogs/model";
import {
  EnforcementError,
  terminal,
  validateDecision,
  type Action,
  type Intent,
  type Operation,
  type Projection,
} from "./model";
import type { EnforcementStore } from "./store";
import type { BanProvider } from "./provider";

export class BanCaseEnforcement {
  private readonly now: () => number;
  constructor(
    private readonly options: {
      store: EnforcementStore;
      cases: BanCaseStore;
      provider: BanProvider;
      authorize: (guildId: string, actorId: string) => Promise<boolean>;
      available: (guildId: string) => Promise<boolean>;
      audit?: (operation: Operation, kind: "request" | "outcome") => Promise<void>;
      notify?: (
        operation: Operation & Projection,
        beforeCreate: () => Promise<void>,
      ) => Promise<string | null>;
      now?: () => number;
      wait?: (ms: number) => Promise<void>;
    },
  ) {
    this.now = options.now ?? Date.now;
  }
  async check(intent: Intent) {
    const c = await this.options.cases.readBanCase(intent.guildId, intent.caseId);
    if (
      !c ||
      c.subject.platform !== "steam" ||
      c.subject.id !== intent.subject ||
      !(await this.options.available(intent.guildId)) ||
      !(await this.options.authorize(intent.guildId, intent.actorId))
    )
      throw new EnforcementError(
        "Current Ban Case staff authority and service availability are required.",
      );
    const target = await this.options.provider.readiness(
      intent.guildId,
      intent.targetId,
      intent.action,
    );
    if (
      !target.ready ||
      target.target?.generation !== intent.generation ||
      target.physicalTarget !== intent.physicalTarget ||
      target.approvalIdentity !== intent.approvalIdentity
    )
      throw new EnforcementError(
        "The target is disabled, changed, or lacks approved ban-management capabilities.",
      );
  }
  async prepare(
    input: {
      guildId: string;
      actorId: string;
      caseId: string;
      targetId: string;
      action: Action;
      reason: string;
    },
    draft = false,
  ) {
    const c = await this.options.cases.readBanCase(input.guildId, input.caseId);
    if (!c || c.subject.platform !== "steam")
      throw new EnforcementError("This case must have a persisted SteamID64 subject.");
    validateDecision(c.subject.id, input.action, input.reason);
    const target = await this.options.provider.readiness(
      input.guildId,
      input.targetId,
      input.action,
    );
    if (!target.target) throw new EnforcementError("Target not found in this Guild.");
    const intent: Intent = {
      ...input,
      draft,
      id: crypto.randomUUID(),
      subject: c.subject.id,
      targetLabel: target.target.name,
      generation: target.target.generation,
      physicalTarget: target.physicalTarget,
      approvalIdentity: target.approvalIdentity,
      createdAtMs: this.now(),
      expiresAtMs: this.now() + 5 * 60_000,
    };
    await this.check(intent);
    return this.options.store.prepare(intent);
  }
  async select(input: {
    guildId: string;
    actorId: string;
    caseId: string;
    targetId: string;
    action: Action;
  }) {
    const prepared = await this.prepare({ ...input, reason: "Awaiting staff reason" }, true);
    return prepared;
  }
  async submitReason(id: string, guildId: string, actorId: string, reason: string) {
    const draft = await this.options.store.confirmation(id, guildId, actorId);
    if (!draft?.draft || draft.expiresAtMs <= this.now())
      throw new EnforcementError("Selection expired or belongs to another actor.");
    await this.check(draft);
    return this.prepare({ ...draft, reason });
  }
  async confirm(id: string, guildId: string, actorId: string) {
    const intent = await this.options.store.confirmation(id, guildId, actorId);
    if (!intent || intent.draft || intent.expiresAtMs <= this.now())
      throw new EnforcementError("Confirmation expired or belongs to another actor or Guild.");
    await this.check(intent);
    return this.options.store.confirm({
      ...intent,
      state: "pending",
      revision: 1,
      attempts: 0,
      confirmedAtMs: this.now(),
      expiresAtMs: this.now() + 15 * 60_000,
      nextAtMs: this.now(),
      attemptAtMs: null,
      completedAtMs: null,
      transmittedAtMs: null,
      acknowledgedAtMs: null,
      outcome: "requested",
      before: null,
      after: null,
    });
  }
  async list(guildId: string, actorId: string) {
    if (!(await this.options.authorize(guildId, actorId)))
      throw new EnforcementError("Ban Case staff access required.");
    return this.options.store.list(guildId);
  }
  async cancel(id: string, guildId: string, actorId: string) {
    const op = await this.options.store.read(id);
    if (!op || op.guildId !== guildId || op.transmittedAtMs !== null || op.state !== "pending")
      throw new EnforcementError("Only undispatched pending work can be cancelled.");
    if (!(await this.options.authorize(guildId, actorId)))
      throw new EnforcementError("Ban Case staff access required.");
    return this.options.store.save(
      { ...op, state: "cancelled", outcome: "cancelled by staff", completedAtMs: this.now() },
      op.revision,
    );
  }
  async processDue() {
    for (const op of await this.options.store.due(this.now())) {
      try {
        // Complete the short read/write stages in this sweep. The maintenance
        // scheduler runs every five minutes; another full tick is not a short delay.
        for (let stage = 0; stage < 4; stage++) {
          await this.process(op.id);
          const next = await this.options.store.read(op.id);
          if (!next || terminal(next.state)) break;
          const delay = next.nextAtMs - this.now();
          if (delay <= 0 || delay > 60_000 / WARDOGS_POLICY.requestsPerMinute) break;
          await (
            this.options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
          )(delay);
        }
      } catch {
        /* Durable claim expires; uncertainty is retained. */
      }
    }
    await this.projectDue();
  }

  async projectDue() {
    if (this.options.notify)
      for (const op of await this.options.store.notifications(this.now())) {
        let projection = await this.options.store.projection(op.id);
        if (!projection || projection.nextAtMs > this.now()) continue;
        try {
          const claimed = await this.options.store.saveProjection(
            { ...projection, nextAtMs: this.now() + 60_000 },
            projection.token,
          );
          if (!claimed) continue;
          projection = claimed;
          const auditRequest = !projection.auditRequested;
          const auditOutcome =
            (terminal(op.state) || op.state === "needs-attention") &&
            projection.auditOutcome !== op.outcome;
          const marked = await this.options.store.saveProjection(
            {
              ...projection,
              auditRequested: true,
              ...(auditOutcome ? { auditOutcome: op.outcome } : {}),
            },
            projection.token,
          );
          if (!marked) continue;
          projection = marked;
          // The durable operation is the private audit. Discord audit delivery is at most once.
          try {
            if (auditRequest) await this.options.audit?.(op, "request");
            if (auditOutcome) await this.options.audit?.(op, "outcome");
          } catch {
            /* Retain the durable audit. */
          }
          try {
            const messageId = await this.options.notify({ ...op, ...projection }, async () => {
              if (projection!.nextAtMs <= this.now())
                throw new EnforcementError("Notification claim expired before create.");
              const started = await this.options.store.saveProjection(
                { ...projection!, notificationStarted: true },
                projection!.token,
              );
              if (!started) throw new EnforcementError("Stale notification claim.");
              projection = started;
            });
            const delivered = await this.options.store.saveProjection(
              {
                ...projection,
                messageId,
                notificationRevision: op.revision,
                nextAtMs: this.now(),
              },
              projection.token,
            );
            if (delivered) continue;
          } catch {
            // A failed PATCH may also have applied after a newer worker's update.
          }
          await this.requeueStaleProjection(projection);
        } catch {
          /* Projection retries never change the mutation claim. */
        }
      }
  }

  private async requeueStaleProjection(stale: Projection) {
    let latest = await this.options.store.projection(stale.id);
    while (latest && latest.token !== stale.token) {
      // Preserve the current lease and create/audit receipts. Rotating its token also
      // fences a newer completion racing this repair, so it cannot erase the retry.
      if (
        await this.options.store.saveProjection(
          { ...latest, notificationRevision: 0 },
          latest.token,
        )
      )
        return;
      latest = await this.options.store.projection(stale.id);
    }
  }

  async process(id: string) {
    let op = await this.options.store.read(id);
    if (!op || terminal(op.state) || op.nextAtMs > this.now()) return;
    const claimed = await this.options.store.save(
      { ...op, nextAtMs: this.now() + 30_000 },
      op.revision,
    );
    if (!claimed) return;
    op = claimed;
    const save = async (patch: Partial<Operation>) => {
      const updated = await this.options.store.save({ ...op!, ...patch }, op!.revision);
      if (!updated) throw new EnforcementError("Stale operation claim.");
      op = updated;
    };
    const finish = (state: Operation["state"], outcome: string) =>
      save({
        state,
        outcome,
        completedAtMs: terminal(state) ? this.now() : null,
        nextAtMs: this.now() + 60_000,
      });
    const current = async () => {
      if ((await this.options.store.read(id))?.revision !== op!.revision)
        throw new EnforcementError("Stale operation claim.");
    };
    if (op.transmittedAtMs === null && op.expiresAtMs <= this.now()) {
      await finish("expired", "unsent intent expired");
      return;
    }
    try {
      await this.check(op);
    } catch {
      if (op.transmittedAtMs !== null)
        await finish("needs-attention", "authorization or target changed; transmission unresolved");
      else await finish("cancelled", "authorization, service, or target changed");
      return;
    }
    try {
      await current();
      if (op.transmittedAtMs !== null) {
        const after = await this.options.provider.observe(op);
        await save({ after });
        if (after === (op.action === "ban")) {
          // A matching observation may have been caused by another administrator.
          // Without an acknowledgement, it cannot fence a delayed prior command.
          if (typeof op.acknowledgedAtMs === "number")
            await finish("succeeded", "verified desired state; causation not attributed");
          else
            await finish(
              "needs-attention",
              "verified desired state; prior transmission unresolved; opposite action blocked",
            );
        } else
          await finish(
            "needs-attention",
            after === null
              ? "read-back unavailable; do not resend"
              : "contradictory state; prior command may still apply; do not resend",
          );
        return;
      }
      if (op.attempts >= 5 && !["capability verified", "ready to send"].includes(op.outcome)) {
        await finish("failed", "pre-send attempt limit reached");
        return;
      }
      if (op.outcome === "ready to send") {
        // A restart may resume this stage much later. Never dispatch from the
        // persisted preflight observation: another administrator may have acted.
        const before = await this.options.provider.observe(op);
        await save({ before });
        if (before === null) {
          await finish("failed", "complete ban state unavailable; no command sent");
          return;
        }
        if (before === (op.action === "ban")) {
          await finish(
            "succeeded",
            op.action === "ban" ? "already banned; existing reason preserved" : "already unbanned",
          );
          return;
        }
        await (
          this.options.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
        )(5_000);
        // Revalidate current actor/target immediately before marking possible transmission.
        await this.options.provider.mutate(
          op,
          async () => {
            await this.check(op!);
            await current();
            if (op!.expiresAtMs <= this.now()) throw new EnforcementError("Unsent intent expired.");
            await save({
              state: "executing",
              transmittedAtMs: this.now(),
              attemptAtMs: this.now(),
              outcome: "possible transmission; awaiting read-back",
              nextAtMs: this.now() + 30_000,
            });
          },
          current,
        );
        await current();
        await save({
          state: "verifying",
          acknowledgedAtMs: this.now(),
          outcome: "acknowledged; awaiting read-back",
          nextAtMs: this.now() + 5_000,
        });
      } else if (op.outcome === "capability verified") {
        const before = await this.options.provider.observe(op);
        await save({ before });
        if (before === null) {
          await finish("failed", "complete ban state unavailable; no command sent");
          return;
        }
        if (before === (op.action === "ban")) {
          await finish(
            "succeeded",
            op.action === "ban" ? "already banned; existing reason preserved" : "already unbanned",
          );
          return;
        }
        await save({ outcome: "ready to send", nextAtMs: this.now() + 5_000 });
      } else {
        await save({ attempts: op.attempts + 1, attemptAtMs: this.now() });
        if (!(await this.options.provider.capabilities(op))) {
          await finish("failed", "target capability unavailable");
          return;
        }
        await save({ outcome: "capability verified", nextAtMs: this.now() + 5_000 });
      }
    } catch (error) {
      await current();
      if (error instanceof WardogsPreDispatchError && op.transmittedAtMs !== null)
        // Only this still-owned attempt may undo its marker after proven local rejection.
        await save({ transmittedAtMs: null, state: "pending" });
      if (op.transmittedAtMs !== null) {
        await save({
          state: "verifying",
          outcome: "possible transmission; read-back required; no resend",
          nextAtMs: Math.max(
            this.now() + 60_000,
            error instanceof WardogsError ? (error.retryAtMs ?? 0) : 0,
          ),
        });
      } else {
        const code = error instanceof WardogsError ? error.code : "pre_send_failed";
        if (
          [
            "authentication_failed",
            "forbidden",
            "unsupported_operation",
            "invalid_response",
            "oversized_response",
            "disabled",
            "unapproved_target",
          ].includes(code)
        )
          await finish("failed", code);
        else
          await save({
            state: "pending",
            outcome: "pre-send retry scheduled",
            nextAtMs: Math.max(
              this.now() + 60_000,
              error instanceof WardogsError ? (error.retryAtMs ?? 0) : 0,
            ),
          });
      }
    }
  }
}
