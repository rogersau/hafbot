import { WARDOGS_POLICY, WardogsError, WardogsPreDispatchError } from "../../wardogs/model";
import { commerceEligibility } from "../eligibility";
import type { CommerceEligibilityState } from "../eligibility";
import type { PlatformLinkIdentityReader } from "../../services/platform-link-identity-reader";
import { GameAccessError, steamId, type Assignment, type Fulfillment } from "./model";
import type { GameAccessStore } from "./store";
import type { AccessTarget, GameAccessProvider } from "./provider";

const INTERVAL = 15 * 60_000;
const REQUEST_SPACING_MS = 60_000 / WARDOGS_POLICY.requestsPerMinute;
export interface GameAccessTruth {
  entitlements: CommerceEligibilityState[];
  // True only after trusted terminal evidence, including confirmed pre-session failure,
  // for every associated checkout. A browser return or failed HTTP request is insufficient.
  unpaidAllocationsTerminal: boolean;
  grantsAllowed: boolean;
}
export interface GameAccessOptions {
  store: GameAccessStore;
  provider: GameAccessProvider;
  identities: PlatformLinkIdentityReader;
  truth(assignment: Assignment): Promise<GameAccessTruth>;
  salesAllowed(guildId: string): Promise<boolean>;
  offering(
    offeringId: string,
  ): Promise<{ guildId: string; recurring: boolean; purchased: boolean } | null>;
  audit(input: {
    guildId: string;
    assignmentId?: string;
    offeringId?: string;
    actorId?: string;
    code: string;
    state?: Assignment["state"];
    reason?: string;
  }): Promise<void>;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}
export class CommerceGameAccessService {
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  constructor(private readonly options: GameAccessOptions) {
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }
  async choices(guildId: string, userId: string) {
    return (await this.options.identities.listActiveIdentities(guildId, userId, "steam"))
      .filter(
        (i) =>
          i.guildId === guildId &&
          i.userId === userId &&
          i.active &&
          i.platform === "steam" &&
          i.assurance === "authenticated" &&
          steamId(i.platformId),
      )
      .map((i) => i.platformId);
  }
  async configure(input: {
    offeringId: string;
    guildId: string;
    targetId: string;
    allocationCeiling: number;
    acceptingSales: boolean;
    actorId: string;
  }) {
    const offering = await this.options.offering(input.offeringId);
    if (!offering || offering.guildId !== input.guildId || !offering.recurring)
      throw new GameAccessError("Reserved access requires a recurring offering in this Guild.");
    const target = await this.options.provider.readiness(input.guildId, input.targetId);
    if (
      target.exists === false ||
      target.guildId !== input.guildId ||
      target.targetId !== input.targetId
    )
      throw new GameAccessError("Select a WARDOGS target in this Guild.");
    if (input.acceptingSales && (!target.physicalTarget || !target.origin))
      throw new GameAccessError(
        "An approved reserved-access contract is required to select this target.",
      );
    if (
      !Number.isSafeInteger(input.allocationCeiling) ||
      input.allocationCeiling < 1 ||
      input.allocationCeiling > 2000
    )
      throw new GameAccessError("Choose a valid allocation ceiling.");
    const previous = await this.options.store.config(input.offeringId);
    if (
      offering.purchased &&
      (!previous ||
        previous.targetId !== target.targetId ||
        previous.physicalTarget !== target.physicalTarget ||
        previous.origin !== target.origin)
    )
      throw new GameAccessError("Purchased fulfillment destinations are immutable.");
    const config: Fulfillment = {
      offeringId: input.offeringId,
      guildId: input.guildId,
      targetId: target.targetId,
      physicalTarget: target.physicalTarget,
      origin: target.origin,
      capability: "reserved-slot",
      allocationCeiling: input.allocationCeiling,
      acceptingSales: input.acceptingSales,
      updatedAtMs: this.now(),
    };
    if (config.acceptingSales) await this.saleSnapshot(config);
    await this.options.store.configure(config);
    await this.options.audit({
      guildId: input.guildId,
      offeringId: input.offeringId,
      actorId: input.actorId,
      code: "reserved_access_configured",
    });
    return config;
  }
  async readiness(offeringId: string) {
    const config = await this.options.store.config(offeringId);
    if (!config) return null;
    const target = await this.options.provider.readiness(config.guildId, config.targetId);
    const blockers: string[] = [];
    if (!(await this.options.salesAllowed(config.guildId)))
      blockers.push("provider_validation_required");
    if (!config.acceptingSales) blockers.push("new_sales_disabled");
    if (!target.physicalTarget || target.capacity < 1) blockers.push("capacity_contract_unknown");
    if (!target.ready) blockers.push("target_verification_required");
    return { offeringId, capability: config.capability, ready: blockers.length === 0, blockers };
  }
  async assertPublication(offeringId: string) {
    const config = await this.options.store.config(offeringId);
    if (config) await this.saleSnapshot(config);
  }
  async checkout(input: {
    offeringId: string;
    guildId: string;
    buyerId: string;
    userId: string;
    checkoutId: string;
    subject?: string;
  }) {
    const config = await this.options.store.config(input.offeringId);
    if (!config) return;
    if (config.guildId !== input.guildId) throw new GameAccessError("Offering scope changed.");
    const ids = await this.choices(input.guildId, input.userId);
    const subject = input.subject ?? (ids.length === 1 ? ids[0] : undefined);
    if (!subject || !ids.includes(subject))
      throw new GameAccessError(
        ids.length
          ? "Choose an authenticated linked Steam account."
          : "Link and authenticate your Steam account using the Steam button in this Discord server’s Platform Link panel, then return to checkout.",
      );
    const previous = await this.options.store.selection(input.checkoutId);
    if (
      previous &&
      (previous.subject !== subject ||
        previous.userId !== input.userId ||
        previous.offeringId !== input.offeringId ||
        previous.guildId !== input.guildId ||
        previous.buyerId !== input.buyerId)
    )
      throw new GameAccessError("Checkout identity cannot be substituted.");
    const { available } = await this.saleSnapshot(config);
    const now = this.now();
    const assignment = await this.options.store.reserve(
      {
        platform: "steam",
        id: crypto.randomUUID(),
        guildId: input.guildId,
        userId: input.userId,
        targetId: config.targetId,
        physicalTarget: config.physicalTarget,
        origin: config.origin,
        subject,
        ownership: "none",
        generation: 1,
        revision: 1,
        desired: false,
        state: "pending",
        reason: "awaiting_payment",
        entitlementIds: [],
        attempts: 0,
        nextAtMs: now,
        updatedAtMs: now,
        transmitted: null,
        observed: null,
        obligation: false,
        slot: null,
      },
      available,
    );
    await this.options.store.select({
      platform: "steam",
      checkoutId: input.checkoutId,
      offeringId: input.offeringId,
      guildId: input.guildId,
      buyerId: input.buyerId,
      userId: input.userId,
      subject,
      assignmentId: assignment.id,
      createdAtMs: now,
    });
  }
  async revalidateCheckout(checkoutId: string, guildId: string, userId: string) {
    const selection = await this.options.store.selection(checkoutId);
    if (!selection || selection.guildId !== guildId || selection.userId !== userId)
      throw new GameAccessError("Checkout identity cannot be substituted.");
    const config = await this.options.store.config(selection.offeringId);
    if (!config) throw new GameAccessError("Reserved-access configuration changed.");
    const { available } = await this.saleSnapshot(config);
    // Recheck the exact identity after the budget waits and provider reads, just before Stripe.
    const link = await this.options.identities.readIdentity(
      guildId,
      userId,
      "steam",
      selection.subject,
    );
    if (
      !link?.active ||
      link.assurance !== "authenticated" ||
      link.guildId !== guildId ||
      link.userId !== userId ||
      link.platform !== "steam" ||
      link.platformId !== selection.subject
    )
      throw new GameAccessError(
        "Authenticate the original selected Steam account before checkout.",
      );
    const assignment = await this.options.store.read(selection.assignmentId);
    if (!assignment || assignment.slot === null || assignment.slot >= available)
      throw new GameAccessError("Reserved-access capacity is unavailable.");
  }
  private async saleSnapshot(config: Fulfillment) {
    if (!config.acceptingSales || !(await this.options.salesAllowed(config.guildId)))
      throw new GameAccessError("Reserved-access sales are disabled pending provider validation.");
    const target = await this.target(config);
    if (!(await this.options.provider.capabilities(target)))
      throw new GameAccessError("Reserved-access capabilities require verification.");
    await this.wait(REQUEST_SPACING_MS);
    const observed = await this.options.provider.list(target);
    const assignments = (await this.options.store.list()).filter(
      (a) => a.physicalTarget === config.physicalTarget,
    );
    const managed = assignments.filter((a) => a.ownership === "haf");
    const external = [...observed].filter((id) => !managed.some((a) => a.subject === id)).length;
    const available = target.capacity - external;
    if (
      config.allocationCeiling > available ||
      available < 1 ||
      assignments.some((a) => a.slot !== null && a.slot >= config.allocationCeiling)
    )
      throw new GameAccessError("Verified reserved-access capacity is unavailable.");
    return { target, available: Math.min(available, config.allocationCeiling) };
  }
  private async target(
    config: Pick<Fulfillment, "guildId" | "targetId" | "physicalTarget" | "origin">,
  ) {
    const target = await this.options.provider.readiness(config.guildId, config.targetId);
    if (
      !target.ready ||
      !target.physicalTarget ||
      target.physicalTarget !== config.physicalTarget ||
      target.origin !== config.origin ||
      !Number.isSafeInteger(target.capacity) ||
      target.capacity < 1
    )
      throw new GameAccessError(
        "Target unavailable; outstanding access may require manual removal.",
      );
    return target;
  }
  private async eligibility(a: Assignment) {
    const truth = await this.options.truth(a);
    const link = await this.options.identities.readIdentity(
      a.guildId,
      a.userId,
      "steam",
      a.subject,
    );
    const linked =
      link?.active &&
      link.assurance === "authenticated" &&
      link.platform === "steam" &&
      link.platformId === a.subject &&
      link.guildId === a.guildId &&
      link.userId === a.userId;
    const eligible = truth.entitlements.filter(
      (e) =>
        e.guildId === a.guildId &&
        e.discordUserId === a.userId &&
        commerceEligibility(e, this.now()).action === "assign",
    );
    return {
      truth,
      desired: Boolean(linked && eligible.length),
      ids: eligible.map((e) => e.entitlementId).sort(),
      withheld:
        Boolean(eligible.length && !linked) ||
        truth.entitlements.some(
          (e) => commerceEligibility(e, this.now()).reason === "member_absent",
        ),
      reason: !linked ? "selected_identity_unavailable" : "member_absent",
    };
  }
  async processDue() {
    return this.sweepOutbox({
      send: async (message) => {
        await this.processMessage(message);
      },
    });
  }
  async sweepOutbox(queue: import("./model").GameAccessQueue) {
    const due = await this.options.store.due(this.now());
    const groups = new Map<string, import("./model").GameAccessMessage>();
    for (const a of due) {
      const key = `${a.guildId}:${a.targetId}`;
      if (!groups.has(key) && groups.size >= 5) continue;
      let current: Awaited<ReturnType<CommerceGameAccessService["eligibility"]>>;
      try {
        current = await this.eligibility(a);
      } catch {
        await this.persist({
          ...a,
          state: "needs-attention",
          reason: "eligibility_unavailable",
          nextAtMs: this.now() + INTERVAL,
        });
        continue;
      }
      const changed = current.desired !== a.desired;
      // Publication alone must not invalidate a message already delayed in the Queue.
      // Claims, changed truth and financial commits still advance the revision.
      const saved =
        changed || JSON.stringify(current.ids) !== JSON.stringify(a.entitlementIds)
          ? await this.persist({
              ...a,
              desired: current.desired,
              entitlementIds: current.ids,
              generation: a.generation + (changed ? 1 : 0),
              attempts: changed ? 0 : a.attempts,
              nextAtMs: this.now() + 60_000,
            })
          : await this.options.store.deferPublication(a, this.now() + 60_000);
      if (!saved) continue;
      const group = groups.get(key) ?? { assignments: [] };
      group.assignments.push({
        assignmentId: saved.id,
        generation: saved.generation,
        revision: saved.revision,
      });
      groups.set(key, group);
    }
    for (const message of groups.values()) await queue.send(message);
    return due.length;
  }
  async processMessage(message: import("./model").GameAccessMessage) {
    const groups = new Map<string, Assignment[]>();
    const budget = { mutations: 10 };
    for (const work of message.assignments) {
      const a = await this.options.store.read(work.assignmentId);
      if (!a || a.generation !== work.generation || a.revision !== work.revision) continue;
      const claimed = await this.options.store.save(
        { ...a, nextAtMs: this.now() + INTERVAL },
        a.revision,
      );
      if (!claimed) continue;
      const key = `${a.guildId}:${a.targetId}`;
      groups.set(key, [...(groups.get(key) ?? []), claimed]);
    }
    for (const assignments of groups.values()) {
      let target: AccessTarget | undefined;
      let observed: Set<string> | undefined;
      try {
        target = await this.target(assignments[0]);
        if (!(await this.options.provider.capabilities(target)))
          throw new GameAccessError("Unsupported reserved access.");
        await this.wait(REQUEST_SPACING_MS);
        observed = await this.options.provider.list(target);
      } catch {
        /* Unknown is never an empty server list. */
      }
      for (const a of assignments) {
        try {
          await this.reconcile(a, budget, target, observed);
        } catch {
          await this.failure(a.id);
        }
      }
    }
  }
  private async reconcile(
    a: Assignment,
    budget: { mutations: number },
    target?: AccessTarget,
    observed?: Set<string>,
  ) {
    const current = await this.eligibility(a);
    const changed = current.desired !== a.desired;
    a = {
      ...a,
      desired: current.desired,
      entitlementIds: current.ids,
      generation: a.generation + (changed ? 1 : 0),
      attempts: changed ? 0 : a.attempts,
      updatedAtMs: this.now(),
    };
    if (!target || !observed) {
      await this.persist({
        ...a,
        attempts: Math.min(5, a.attempts + 1),
        state: "needs-attention",
        reason: "target_unavailable_manual_removal_may_be_required",
      });
      return;
    }
    const present = observed.has(a.subject);
    a.observed = present;
    if (a.transmitted) {
      if (!a.transmitted.acknowledged) {
        await this.persist({
          ...a,
          ownership:
            a.transmitted.action === "grant" && a.ownership !== "haf" ? "uncertain" : a.ownership,
          state: "needs-attention",
          reason: "possible_late_operation",
          obligation: true,
        });
        return;
      }
      const settled = a.transmitted.action === "grant" ? present : !present;
      if (!settled) {
        await this.persist({
          ...a,
          state: "needs-attention",
          reason: "acknowledgement_not_verified",
          obligation: true,
        });
        return;
      }
      a.ownership = a.transmitted.action === "grant" ? "haf" : "none";
      a.obligation = a.transmitted.action === "grant";
      a.transmitted = null;
    }
    if (a.ownership === "uncertain") {
      await this.persist({ ...a, state: "needs-attention", reason: "ownership_unknown" });
      return;
    }
    if (a.ownership === "none" && present) a.ownership = "external";
    if (a.ownership === "external") {
      await this.persist({
        ...a,
        state: a.desired ? (present ? "externally-managed" : "needs-attention") : "withheld",
        reason: present ? "external_access_not_owned" : "external_access_changed",
        slot: a.desired || !current.truth.unpaidAllocationsTerminal ? a.slot : null,
      });
      return;
    }
    if (!a.desired && a.ownership === "none") {
      await this.persist({
        ...a,
        state: current.withheld
          ? "withheld"
          : current.truth.unpaidAllocationsTerminal
            ? "removed"
            : "pending",
        reason: current.withheld ? current.reason : "no_eligible_entitlement",
        slot: current.truth.unpaidAllocationsTerminal ? null : a.slot,
        obligation: false,
      });
      return;
    }
    if (a.ownership === "haf" && !present && a.desired) {
      await this.persist({
        ...a,
        state: "needs-attention",
        reason: "managed_entry_changed",
        obligation: true,
      });
      return;
    }
    if (a.desired && present) {
      await this.persist({ ...a, state: "managed", reason: "verified_present", attempts: 0 });
      return;
    }
    if (!a.desired && !present) {
      await this.persist({
        ...a,
        ownership: "none",
        state: "removed",
        reason: "verified_absent",
        obligation: false,
        slot: current.truth.unpaidAllocationsTerminal ? null : a.slot,
      });
      return;
    }
    const action = a.desired ? "grant" : "remove";
    if (a.attempts >= 5) {
      await this.persist({ ...a, state: "needs-attention", reason: "attempts_exhausted" });
      return;
    }
    if (action === "grant") {
      if (!current.truth.grantsAllowed) {
        await this.persist({ ...a, state: "withheld", reason: "new_grants_disabled" });
        return;
      }
      // Late successful payments must acquire capacity again before delivery.
      const all = (await this.options.store.list()).filter(
        (x) => x.physicalTarget === a.physicalTarget,
      );
      const external = [...observed].filter(
        (id) => !all.some((x) => x.subject === id && x.ownership === "haf"),
      ).length;
      const available = target.capacity - external;
      if (a.slot === null) {
        const selections = await this.options.store.selections(a.id);
        const ceilings: number[] = [];
        for (const selection of selections) {
          const config = await this.options.store.config(selection.offeringId);
          if (config && config.physicalTarget === a.physicalTarget)
            ceilings.push(config.allocationCeiling);
        }
        const saved = await this.persist(a);
        if (!saved) return;
        a = saved;
        try {
          a = await this.options.store.reserve(a, Math.min(available, ...ceilings, 2000));
        } catch {
          await this.persist({
            ...a,
            state: "needs-attention",
            reason: "capacity_requires_review",
          });
          return;
        }
      }
      if (a.slot === null || a.slot >= available) {
        await this.persist({ ...a, state: "needs-attention", reason: "capacity_requires_review" });
        return;
      }
    }
    if (budget.mutations <= 0) {
      await this.persist({
        ...a,
        state: action === "grant" ? "pending" : "removal-pending",
        reason: "scheduled_next_batch",
      });
      return;
    }
    budget.mutations--;
    const pending = await this.persist({
      ...a,
      state: action === "grant" ? "pending" : "removal-pending",
      reason: "dispatch_pending",
      attempts: a.attempts + 1,
    });
    if (!pending) return;
    await this.wait(REQUEST_SPACING_MS);
    let sent: Assignment | null = null;
    let dispatchAttempt:
      | { before: Assignment; transmitted: NonNullable<Assignment["transmitted"]> }
      | undefined;
    try {
      await this.options.provider.mutate(target, a.subject, action, async () => {
        const latest = await this.options.store.read(a.id);
        if (!latest || latest.revision !== pending.revision || latest.transmitted)
          throw new GameAccessError("Superseded operation.");
        const fresh = await this.eligibility(latest);
        if (
          fresh.desired !== (action === "grant") ||
          (action === "grant" && !fresh.truth.grantsAllowed)
        )
          throw new GameAccessError("Eligibility changed before dispatch.");
        const authority = await this.target(latest);
        if (authority.generation !== target.generation)
          throw new GameAccessError("Target generation changed.");
        dispatchAttempt = {
          before: latest,
          transmitted: {
            operationId: crypto.randomUUID(),
            action,
            acknowledged: false,
            atMs: this.now(),
            generation: latest.generation,
          },
        };
        sent = await this.persist({
          ...latest,
          transmitted: dispatchAttempt.transmitted,
          obligation: true,
        });
        if (!sent) throw new GameAccessError("Superseded operation.");
      });
    } catch (error) {
      await this.failure(a.id, error, dispatchAttempt);
      return;
    }
    const dispatched = await this.options.store.read(a.id);
    if (
      !sent ||
      !dispatched?.transmitted ||
      dispatched.transmitted.operationId !== dispatchAttempt?.transmitted.operationId ||
      dispatched.transmitted.generation !== pending.generation
    )
      return;
    const acknowledged = await this.persist({
      ...dispatched,
      transmitted: { ...dispatched.transmitted, acknowledged: true },
    });
    if (!acknowledged) return;
    await this.wait(REQUEST_SPACING_MS);
    const after = await this.options.provider.list(target);
    observed.clear();
    for (const id of after) observed.add(id);
    // Settle evidence without issuing an opposite action in this cycle.
    const verified = action === "grant" ? after.has(a.subject) : !after.has(a.subject);
    await this.persist({
      ...acknowledged,
      ownership: verified ? (action === "grant" ? "haf" : "none") : acknowledged.ownership,
      state: verified ? (action === "grant" ? "managed" : "removed") : "needs-attention",
      reason: verified ? "readback_verified" : "acknowledgement_not_verified",
      transmitted: verified ? null : acknowledged.transmitted,
      obligation: !verified || action === "grant",
      nextAtMs: dispatched.generation !== pending.generation ? this.now() : acknowledged.nextAtMs,
      slot:
        verified && action === "remove" && current.truth.unpaidAllocationsTerminal
          ? null
          : acknowledged.slot,
    });
  }
  private async persist(a: Assignment) {
    const previous = await this.options.store.read(a.id);
    const saved = await this.options.store.save(a, a.revision);
    if (
      saved &&
      (previous?.state !== a.state ||
        previous?.ownership !== a.ownership ||
        previous?.reason !== a.reason ||
        previous?.generation !== a.generation)
    )
      await this.options.audit({
        guildId: a.guildId,
        assignmentId: a.id,
        code: a.reason,
        state: a.state,
      });
    return saved;
  }
  private async failure(
    id: string,
    error?: unknown,
    dispatchAttempt?: { before: Assignment; transmitted: NonNullable<Assignment["transmitted"]> },
  ) {
    let a = await this.options.store.read(id);
    if (!a) return;
    if (
      error instanceof WardogsPreDispatchError &&
      dispatchAttempt &&
      a.transmitted &&
      !a.transmitted.acknowledged &&
      dispatchAttempt.transmitted.operationId &&
      a.transmitted.operationId === dispatchAttempt.transmitted.operationId &&
      a.transmitted.action === dispatchAttempt.transmitted.action &&
      a.transmitted.generation === dispatchAttempt.transmitted.generation &&
      a.transmitted.atMs === dispatchAttempt.transmitted.atMs
    ) {
      // Only this invocation's proven-unsent marker can be cleared. Another worker
      // may have observed it as uncertain; no transport was entered, so restore the
      // prior ownership/obligation while retaining current truth and CAS fences.
      a = {
        ...a,
        transmitted: null,
        ownership: dispatchAttempt.before.ownership,
        obligation: dispatchAttempt.before.obligation,
      };
    }
    await this.persist({
      ...a,
      state: "needs-attention",
      reason: a.transmitted
        ? "possible_late_operation"
        : error instanceof WardogsError
          ? error.code
          : "provider_unavailable",
      nextAtMs: Math.max(
        this.now() + Math.min(INTERVAL, 30_000 * 2 ** a.attempts),
        error instanceof WardogsError ? (error.retryAtMs ?? 0) : 0,
      ),
      ownership:
        a.transmitted?.action === "grant" && a.ownership !== "haf" ? "uncertain" : a.ownership,
      obligation: a.obligation || Boolean(a.transmitted),
    });
  }
  async repair(input: {
    guildId: string;
    id: string;
    actorId: string;
    reason: string;
    handoff?: boolean;
  }) {
    if (input.reason.trim().length < 10 || input.reason.length > 500)
      throw new GameAccessError("A repair reason is required.");
    const a = await this.options.store.read(input.id);
    if (!a || a.guildId !== input.guildId) throw new GameAccessError("Assignment unavailable.");
    if (a.transmitted || a.ownership === "uncertain")
      throw new GameAccessError(
        "Resolve the possible late operation with the provider before repair.",
      );
    if (input.handoff && (await this.eligibility(a)).desired)
      throw new GameAccessError("End eligible fulfillment before handing access off.");
    const repaired = await this.persist({
      ...a,
      generation: a.generation + 1,
      attempts: 0,
      nextAtMs: this.now(),
      ...(input.handoff
        ? {
            ownership: "external" as const,
            obligation: false,
            slot: null,
            state: "withheld" as const,
            reason: "operator_handoff",
          }
        : { reason: "operator_repair" }),
    });
    if (!repaired) throw new GameAccessError("Assignment changed; reload before repair.");
    await this.options.audit({
      guildId: input.guildId,
      assignmentId: input.id,
      actorId: input.actorId,
      reason: input.reason,
      code: input.handoff ? "operator_handoff" : "operator_repair",
    });
  }
}
