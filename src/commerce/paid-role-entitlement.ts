import { type CommerceEligibilityState, commerceEligibility as desiredAction } from "./eligibility";
/**
 * Commerce-owned paid-role delivery boundary.
 *
 * Stripe/webhook and browser callers may submit a projection to this service,
 * but only a trusted reconciliation/administrative command is allowed to
 * mutate Discord.  The store is deliberately narrow so this module can be
 * used with durable persistence or a test double.
 */

export type PaidRoleSource = "webhook" | "browser" | "checkout" | "scheduled" | "support" | "admin";
export type PaidRoleAssignmentState =
  | "pending"
  | "managed"
  | "withheld"
  | "removing"
  | "removed"
  | "failed";
export type PaidRoleMemberState = "present" | "left" | "kicked" | "rejoined" | "banned";
export type PaidRoleAdminAction = "suspend" | "revoke";
export type PaidRoleWithheldReason = "member_absent" | "guild_ban" | "dispute" | "admin_suspension";
export type PaidRoleProviderCancellationState =
  | "none"
  | "pending"
  | "scheduled"
  | "completed"
  | "failed";

export interface PaidRoleManagedAssignment {
  id: string;
  entitlementId: string;
  guildId: string;
  discordUserId: string;
  discordRoleId: string;
  state: PaidRoleAssignmentState;
  withheldReason: PaidRoleWithheldReason | null;
  providerCancellationState: PaidRoleProviderCancellationState;
  attemptCount: number;
  lastErrorCode: string | null;
  assignedAtMs: number | null;
  removedAtMs: number | null;
  updatedAtMs: number;
}

export interface PaidRoleEntitlementState extends CommerceEligibilityState {
  discordRoleId: string;
}

export interface PaidRoleEntitlementStore {
  readState(entitlementId: string): Promise<PaidRoleEntitlementState | null>;
  saveState(state: PaidRoleEntitlementState): Promise<void>;
  readManagedAssignment(input: {
    entitlementId: string;
    guildId: string;
    discordUserId: string;
    discordRoleId: string;
  }): Promise<PaidRoleManagedAssignment | null>;
  saveManagedAssignment(assignment: PaidRoleManagedAssignment): Promise<void>;
  listManagedAssignments(input: {
    offeringId?: string;
    guildId: string;
    discordRoleId: string;
  }): Promise<PaidRoleManagedAssignment[]>;
  enqueueProviderAction(
    input: PaidRoleProviderActionInput,
  ): Promise<PaidRoleProviderCancellationState>;
  /** Returns false when this operation key has already been committed. */
  appendOperation(input: {
    operationKey: string;
    entitlementId: string;
    operationType: string;
    createdAtMs: number;
  }): Promise<boolean>;
  /** Release a claimed operation after an effect failure so it can retry. */
  releaseOperation?(operationKey: string): Promise<void>;
  /** Mark a claimed operation complete after all effects and durable projections succeed. */
  commitOperation?(operationKey: string, committedAtMs: number): Promise<void>;
}

export interface PaidRoleDiscordAdapter {
  hasRole(input: {
    guildId: string;
    discordUserId: string;
    discordRoleId: string;
  }): Promise<boolean>;
  preflightRole(input: {
    guildId: string;
    discordRoleId: string;
    discordUserId?: string;
    action: "assign" | "remove";
  }): Promise<PaidRoleRolePreflight>;
  addRole(input: {
    guildId: string;
    discordUserId: string;
    discordRoleId: string;
    idempotencyKey: string;
  }): Promise<void>;
  removeRole(input: {
    guildId: string;
    discordUserId: string;
    discordRoleId: string;
    idempotencyKey: string;
  }): Promise<void>;
}

export interface PaidRoleRolePreflight {
  ok: boolean;
  code?: "permission" | "hierarchy" | "role_missing" | "member_missing" | "unknown";
}

export interface PaidRoleNotifier {
  notify(input: {
    kind:
      | "grace_started"
      | "grace_expired"
      | "suspended"
      | "restored"
      | "removed"
      | "repair_failed";
    entitlementId: string;
    guildId: string;
    discordUserId: string;
    safeReason: string;
    operationKey: string;
  }): Promise<void>;
}

export interface PaidRoleAuditWriter {
  audit(input: {
    operationKey: string;
    operationType: string;
    entitlementId: string;
    guildId: string;
    discordUserId: string;
    safeReason: string;
    createdAtMs: number;
  }): Promise<void>;
}

export interface PaidRoleIncidentWriter {
  incident(input: {
    incidentKey: string;
    entitlementId: string;
    guildId: string;
    discordUserId: string;
    code:
      | "permission"
      | "hierarchy"
      | "role_missing"
      | "member_missing"
      | "repair_window_expired"
      | "repair_failed";
    safeReason: string;
    createdAtMs: number;
  }): Promise<void>;
}

export interface PaidRoleProviderSubscriptionOperations {
  cancelAtPeriodEnd(input: {
    connectedAccountId: string;
    subscriptionId: string;
    idempotencyKey: string;
  }): Promise<void>;
  cancelImmediately(input: {
    connectedAccountId: string;
    subscriptionId: string;
    idempotencyKey: string;
  }): Promise<void>;
}

export interface PaidRoleProviderActionInput {
  operationKey: string;
  assignmentId: string | null;
  connectedAccountId: string;
  subscriptionId: string;
  actionType: "subscription.cancel_at_period_end" | "subscription.cancel_immediately";
  reasonCode: string;
  nowMs: number;
}

export interface PaidRoleEntitlementInput {
  operationKey: string;
  source: PaidRoleSource;
  nowMs: number;
  state: PaidRoleEntitlementState;
}

export interface PaidRoleEntitlementDecision {
  action: "assign" | "retain" | "remove" | "noop" | "quarantine" | "repair";
  reason:
    | "active_paid"
    | "failed_payment_grace"
    | "cancel_at_period_end"
    | "member_absent"
    | "payment_unpaid"
    | "payment_failed_after_grace"
    | "ended"
    | "full_refund"
    | "dispute_suspended"
    | "dispute_won"
    | "dispute_lost"
    | "admin_suspended"
    | "admin_revoked"
    | "manual_role_preserved"
    | "already_applied"
    | "preflight_failed"
    | "repair_window_expired"
    | "repair_complete";
  mutated: boolean;
  managed: boolean;
}

const REPAIR_WINDOW_MS = 72 * 60 * 60 * 1_000;

export class PaidRoleEntitlementService {
  constructor(
    private readonly options: {
      store: PaidRoleEntitlementStore;
      discord: PaidRoleDiscordAdapter;
      notifier?: PaidRoleNotifier;
      audit?: PaidRoleAuditWriter;
      incidents?: PaidRoleIncidentWriter;
      createId?: () => string;
    },
  ) {}

  /** Reconcile a verified projection. Webhook/browser inputs are read-only. */
  async reconcile(input: PaidRoleEntitlementInput): Promise<PaidRoleEntitlementDecision> {
    const { state } = input;
    const operationType = state.adminAction
      ? `admin.${state.adminAction}`
      : "entitlement.reconcile";
    if (
      !(await this.options.store.appendOperation({
        operationKey: input.operationKey,
        entitlementId: state.entitlementId,
        operationType,
        createdAtMs: input.nowMs,
      }))
    ) {
      return { action: "noop", reason: "already_applied", mutated: false, managed: false };
    }

    await this.options.store.saveState(state);
    const managed = await this.options.store.readManagedAssignment({
      entitlementId: state.entitlementId,
      guildId: state.guildId,
      discordUserId: state.discordUserId,
      discordRoleId: state.discordRoleId,
    });

    const desired = desiredAction(state, input.nowMs);
    if (input.source === "webhook" || input.source === "browser" || input.source === "checkout") {
      await this.writeAudit(input, operationType, desired.reason);
      return this.finish(input, {
        action: desired.action,
        reason: desired.reason,
        mutated: false,
        managed: managed !== null,
      });
    }

    if (
      (state.memberState === "left" || state.memberState === "kicked") &&
      managed &&
      managed.state !== "removed"
    ) {
      await this.options.store.saveManagedAssignment({
        ...managed,
        state: "withheld",
        withheldReason: "member_absent",
        removedAtMs: null,
        updatedAtMs: input.nowMs,
      });
      await this.writeAudit(input, operationType, "member_absent");
      return this.finish(input, {
        action: "retain",
        reason: "member_absent",
        mutated: false,
        managed: true,
      });
    }

    if (desired.action === "retain") {
      await this.writeAudit(input, operationType, desired.reason);
      return this.finish(input, { ...desired, mutated: false, managed: managed !== null });
    }

    if (desired.action === "assign") {
      if (managed?.state === "managed" && (await this.options.discord.hasRole(state))) {
        await this.writeAudit(input, operationType, desired.reason);
        if (desired.reason === "failed_payment_grace") {
          await this.notify(input, "grace_started");
        } else if (desired.reason === "dispute_won") {
          await this.notify(input, "restored");
        }
        return this.finish(input, {
          action: "retain",
          reason: desired.reason,
          mutated: false,
          managed: true,
        });
      }
      if (!hasRoleOwnership(managed) && (await this.options.discord.hasRole(state))) {
        await this.writeAudit(input, operationType, "manual_role_preserved");
        return this.finish(input, {
          action: "noop",
          reason: "manual_role_preserved",
          mutated: false,
          managed: false,
        });
      }
      const preflight = await this.options.discord.preflightRole({
        guildId: state.guildId,
        discordRoleId: state.discordRoleId,
        discordUserId: state.discordUserId,
        action: "assign",
      });
      if (!preflight.ok) return this.preflightFailure(input, preflight, managed);
      try {
        const assignment = managed ?? this.assignment(state, input.nowMs);
        // Stripe can create a pending projection before HAF has touched the role.
        // Persist our first attempt before Discord so retries retain ownership even
        // if Discord succeeds but the final assignment write fails.
        const pending: PaidRoleManagedAssignment = {
          ...assignment,
          state: "pending",
          attemptCount: Math.max(1, assignment.attemptCount),
          updatedAtMs: input.nowMs,
        };
        await this.options.store.saveManagedAssignment(pending);
        await this.options.discord.addRole({
          guildId: state.guildId,
          discordUserId: state.discordUserId,
          discordRoleId: state.discordRoleId,
          idempotencyKey: input.operationKey,
        });
        await this.options.store.saveManagedAssignment({
          ...pending,
          state: "managed",
          withheldReason: null,
          assignedAtMs: input.nowMs,
          removedAtMs: null,
        });
      } catch (error) {
        await this.options.store.releaseOperation?.(input.operationKey);
        throw error;
      }
      await this.writeAudit(input, operationType, desired.reason);
      await this.notify(
        input,
        desired.reason === "failed_payment_grace" ? "grace_started" : "restored",
      );
      return this.finish(input, {
        action: "assign",
        reason: desired.reason,
        mutated: true,
        managed: true,
      });
    }

    const cancellationRequested =
      shouldCancelProvider(desired.reason) && state.subscriptionId !== null;
    let cancellationState: PaidRoleProviderCancellationState = "none";
    if (cancellationRequested) {
      cancellationState = await this.enqueueCancellation(
        input,
        managed,
        "subscription.cancel_at_period_end",
      );
      if (managed) {
        await this.options.store.saveManagedAssignment({
          ...managed,
          providerCancellationState: cancellationState,
          updatedAtMs: input.nowMs,
        });
      }
    }

    if (!managed || !hasRoleOwnership(managed) || managed.state === "removed") {
      await this.writeAudit(input, operationType, "manual_role_preserved");
      return this.finish(input, {
        action: "noop",
        reason: "manual_role_preserved",
        mutated: false,
        managed: false,
      });
    }
    if (desired.reason === "member_absent" && state.memberState === "banned") {
      await this.options.store.saveManagedAssignment({
        ...managed,
        state: "withheld",
        withheldReason: "guild_ban",
        providerCancellationState: cancellationState,
        removedAtMs: null,
        updatedAtMs: input.nowMs,
      });
      await this.writeAudit(input, operationType, desired.reason);
      await this.notify(input, "removed");
      return this.finish(input, {
        action: "remove",
        reason: desired.reason,
        mutated: true,
        managed: true,
      });
    }
    const preflight = await this.options.discord.preflightRole({
      guildId: state.guildId,
      discordRoleId: state.discordRoleId,
      discordUserId: state.discordUserId,
      action: "remove",
    });
    if (!preflight.ok) return this.preflightFailure(input, preflight, managed);
    try {
      if (await this.options.discord.hasRole(state)) {
        await this.options.discord.removeRole({
          guildId: state.guildId,
          discordUserId: state.discordUserId,
          discordRoleId: state.discordRoleId,
          idempotencyKey: input.operationKey,
        });
      }
      await this.options.store.saveManagedAssignment({
        ...managed,
        state: recoverableWithheldReason(desired.reason) ? "withheld" : "removed",
        withheldReason: recoverableWithheldReason(desired.reason),
        providerCancellationState: cancellationState,
        removedAtMs: recoverableWithheldReason(desired.reason) ? null : input.nowMs,
        updatedAtMs: input.nowMs,
      });
    } catch (error) {
      await this.options.store.releaseOperation?.(input.operationKey);
      throw error;
    }
    await this.writeAudit(input, operationType, desired.reason);
    await this.notify(
      input,
      desired.reason === "dispute_suspended"
        ? "suspended"
        : desired.reason === "payment_failed_after_grace"
          ? "grace_expired"
          : "removed",
    );
    return this.finish(input, {
      action: "remove",
      reason: desired.reason,
      mutated: true,
      managed: true,
    });
  }

  async adminSuspend(
    input: Omit<PaidRoleEntitlementInput, "source">,
  ): Promise<PaidRoleEntitlementDecision> {
    return this.reconcile({
      ...input,
      source: "admin",
      state: { ...input.state, adminAction: "suspend" },
    });
  }

  async adminRevoke(
    input: Omit<PaidRoleEntitlementInput, "source">,
  ): Promise<PaidRoleEntitlementDecision> {
    return this.reconcile({
      ...input,
      source: "admin",
      state: { ...input.state, adminAction: "revoke" },
    });
  }

  async repair(input: {
    operationKey: string;
    guildId: string;
    offeringId: string;
    oldRoleId: string;
    replacementRoleId: string;
    userIds?: string[];
    startedAtMs: number;
    nowMs: number;
  }): Promise<{ action: "repair" | "retry" | "quarantine" | "noop"; repaired: number }> {
    if (
      !(await this.options.store.appendOperation({
        operationKey: input.operationKey,
        entitlementId: `role:${input.guildId}:${input.oldRoleId}`,
        operationType: "entitlement.role_repair",
        createdAtMs: input.nowMs,
      }))
    )
      return { action: "noop", repaired: 0 };
    if (input.nowMs - input.startedAtMs > REPAIR_WINDOW_MS) {
      await this.options.incidents?.incident({
        incidentKey: input.operationKey,
        entitlementId: `role:${input.guildId}:${input.oldRoleId}`,
        guildId: input.guildId,
        discordUserId: "unknown",
        code: "repair_window_expired",
        safeReason: "role_repair_window_expired",
        createdAtMs: input.nowMs,
      });
      const assignments = await this.options.store.listManagedAssignments({
        offeringId: input.offeringId,
        guildId: input.guildId,
        discordRoleId: input.oldRoleId,
      });
      for (const assignment of assignments) {
        const state = await this.options.store.readState(assignment.entitlementId);
        if (state?.subscriptionId) {
          const providerCancellationState = await this.options.store.enqueueProviderAction({
            operationKey: providerOperationKey(
              state.connectedAccountId,
              state.subscriptionId,
              "subscription.cancel_at_period_end",
            ),
            assignmentId: assignment.id,
            connectedAccountId: state.connectedAccountId,
            subscriptionId: state.subscriptionId,
            actionType: "subscription.cancel_at_period_end",
            reasonCode: "role_repair_window_expired",
            nowMs: input.nowMs,
          });
          await this.options.store.saveManagedAssignment({
            ...assignment,
            providerCancellationState,
            updatedAtMs: input.nowMs,
          });
        }
      }
      await this.options.store.commitOperation?.(input.operationKey, input.nowMs);
      return { action: "quarantine", repaired: 0 };
    }
    const preflight = await this.options.discord.preflightRole({
      guildId: input.guildId,
      discordRoleId: input.replacementRoleId,
      action: "assign",
    });
    if (!preflight.ok) {
      await this.options.incidents?.incident({
        incidentKey: input.operationKey,
        entitlementId: `role:${input.guildId}:${input.oldRoleId}`,
        guildId: input.guildId,
        discordUserId: "unknown",
        code: preflight.code === "hierarchy" ? "hierarchy" : "repair_failed",
        safeReason: preflight.code ?? "repair_preflight_failed",
        createdAtMs: input.nowMs,
      });
      await this.options.store.releaseOperation?.(input.operationKey);
      return { action: "retry", repaired: 0 };
    }
    const assignments = await this.options.store.listManagedAssignments({
      offeringId: input.offeringId,
      guildId: input.guildId,
      discordRoleId: input.oldRoleId,
    });
    let repaired = 0;
    for (const assignment of assignments) {
      if (input.userIds && !input.userIds.includes(assignment.discordUserId)) continue;
      if (assignment.state === "removed") continue;
      if (!hasRoleOwnership(assignment)) {
        await this.options.store.saveManagedAssignment({
          ...assignment,
          discordRoleId: input.replacementRoleId,
          updatedAtMs: input.nowMs,
        });
        repaired += 1;
        continue;
      }
      const state = await this.options.store.readState(assignment.entitlementId);
      if (!state) {
        await this.options.store.releaseOperation?.(input.operationKey);
        throw new Error("commerce_role_repair_entitlement_missing");
      }
      if (assignment.state === "withheld") {
        await this.options.store.saveManagedAssignment({
          ...assignment,
          discordRoleId: input.replacementRoleId,
          updatedAtMs: input.nowMs,
        });
        repaired += 1;
        continue;
      }
      if (desiredAction(state, input.nowMs).action !== "assign") {
        try {
          if (await this.options.discord.hasRole(assignment)) {
            await this.options.discord.removeRole({
              guildId: input.guildId,
              discordUserId: assignment.discordUserId,
              discordRoleId: input.oldRoleId,
              idempotencyKey: `${input.operationKey}:${assignment.discordUserId}:remove-ineligible`,
            });
          }
          await this.options.store.saveManagedAssignment({
            ...assignment,
            state: "removed",
            withheldReason: null,
            removedAtMs: input.nowMs,
            updatedAtMs: input.nowMs,
          });
          repaired += 1;
          continue;
        } catch (error) {
          await this.options.store.releaseOperation?.(input.operationKey);
          throw error;
        }
      }
      try {
        await this.options.discord.addRole({
          guildId: input.guildId,
          discordUserId: assignment.discordUserId,
          discordRoleId: input.replacementRoleId,
          idempotencyKey: `${input.operationKey}:${assignment.discordUserId}:add`,
        });
        if (
          await this.options.discord.hasRole({
            guildId: input.guildId,
            discordUserId: assignment.discordUserId,
            discordRoleId: input.oldRoleId,
          })
        ) {
          await this.options.discord.removeRole({
            guildId: input.guildId,
            discordUserId: assignment.discordUserId,
            discordRoleId: input.oldRoleId,
            idempotencyKey: `${input.operationKey}:${assignment.discordUserId}:remove`,
          });
        }
        await this.options.store.saveManagedAssignment({
          ...assignment,
          discordRoleId: input.replacementRoleId,
          updatedAtMs: input.nowMs,
        });
      } catch (error) {
        await this.options.store.releaseOperation?.(input.operationKey);
        throw error;
      }
      repaired += 1;
    }
    await this.options.store.commitOperation?.(input.operationKey, input.nowMs);
    return { action: "repair", repaired };
  }

  private assignment(state: PaidRoleEntitlementState, nowMs: number): PaidRoleManagedAssignment {
    return {
      id: this.options.createId?.() ?? crypto.randomUUID(),
      entitlementId: state.entitlementId,
      guildId: state.guildId,
      discordUserId: state.discordUserId,
      discordRoleId: state.discordRoleId,
      state: "pending",
      withheldReason: null,
      providerCancellationState: "none",
      attemptCount: 1,
      lastErrorCode: null,
      assignedAtMs: null,
      removedAtMs: null,
      updatedAtMs: nowMs,
    };
  }

  private async preflightFailure(
    input: PaidRoleEntitlementInput,
    preflight: PaidRoleRolePreflight,
    managed: PaidRoleManagedAssignment | null,
  ): Promise<PaidRoleEntitlementDecision> {
    const code = preflight.code ?? "unknown";
    if (code === "member_missing") {
      if (managed) {
        const desired = desiredAction(input.state, input.nowMs);
        const reason =
          desired.action === "assign" ? "member_absent" : recoverableWithheldReason(desired.reason);
        await this.options.store.saveManagedAssignment({
          ...managed,
          state: reason ? "withheld" : "removed",
          withheldReason: reason,
          providerCancellationState: shouldCancelProvider(desired.reason)
            ? "pending"
            : managed.providerCancellationState,
          removedAtMs: reason ? null : input.nowMs,
          updatedAtMs: input.nowMs,
        });
      }
      await this.writeAudit(input, "entitlement.reconcile", "member_absent");
      return this.finish(input, {
        action: desiredAction(input.state, input.nowMs).action === "remove" ? "remove" : "retain",
        reason: "member_absent",
        mutated: managed !== null,
        managed: managed !== null,
      });
    }
    await this.options.incidents?.incident({
      incidentKey: input.operationKey,
      entitlementId: input.state.entitlementId,
      guildId: input.state.guildId,
      discordUserId: input.state.discordUserId,
      code:
        code === "hierarchy" || code === "permission" || code === "role_missing"
          ? code
          : "repair_failed",
      safeReason: `role_preflight_${code}`,
      createdAtMs: input.nowMs,
    });
    await this.options.store.releaseOperation?.(input.operationKey);
    return {
      action: "quarantine",
      reason: "preflight_failed",
      mutated: false,
      managed: managed !== null,
    };
  }

  private async writeAudit(
    input: PaidRoleEntitlementInput,
    operationType: string,
    safeReason: string,
  ) {
    await this.options.audit?.audit({
      operationKey: input.operationKey,
      operationType,
      entitlementId: input.state.entitlementId,
      guildId: input.state.guildId,
      discordUserId: input.state.discordUserId,
      safeReason,
      createdAtMs: input.nowMs,
    });
  }

  private async notify(
    input: PaidRoleEntitlementInput,
    kind: Parameters<PaidRoleNotifier["notify"]>[0]["kind"],
  ): Promise<void> {
    await this.options.notifier?.notify({
      kind,
      entitlementId: input.state.entitlementId,
      guildId: input.state.guildId,
      discordUserId: input.state.discordUserId,
      safeReason: desiredAction(input.state, input.nowMs).reason,
      operationKey: input.operationKey,
    });
  }

  private async enqueueCancellation(
    input: PaidRoleEntitlementInput,
    managed: PaidRoleManagedAssignment | null,
    actionType: PaidRoleProviderActionInput["actionType"],
  ): Promise<PaidRoleProviderCancellationState> {
    if (!input.state.subscriptionId) return "none";
    return this.options.store.enqueueProviderAction({
      operationKey: providerOperationKey(
        input.state.connectedAccountId,
        input.state.subscriptionId,
        actionType,
      ),
      assignmentId: managed?.id ?? null,
      connectedAccountId: input.state.connectedAccountId,
      subscriptionId: input.state.subscriptionId,
      actionType,
      reasonCode: desiredAction(input.state, input.nowMs).reason,
      nowMs: input.nowMs,
    });
  }

  private async finish(
    input: Pick<PaidRoleEntitlementInput, "operationKey" | "nowMs">,
    decision: PaidRoleEntitlementDecision,
  ): Promise<PaidRoleEntitlementDecision> {
    await this.options.store.commitOperation?.(input.operationKey, input.nowMs);
    return decision;
  }
}

function hasRoleOwnership(assignment: PaidRoleManagedAssignment | null): boolean {
  return assignment !== null && (assignment.assignedAtMs !== null || assignment.attemptCount > 0);
}
function shouldCancelProvider(reason: PaidRoleEntitlementDecision["reason"]): boolean {
  return (
    reason === "dispute_lost" ||
    reason === "full_refund" ||
    reason === "payment_unpaid" ||
    reason === "ended" ||
    reason === "member_absent"
  );
}

function recoverableWithheldReason(
  reason: PaidRoleEntitlementDecision["reason"],
): PaidRoleWithheldReason | null {
  if (reason === "dispute_suspended") return "dispute";
  if (reason === "admin_suspended") return "admin_suspension";
  return null;
}

export function providerOperationKey(
  connectedAccountId: string,
  subscriptionId: string,
  actionType: PaidRoleProviderActionInput["actionType"],
): string {
  return `paid-role-provider:${connectedAccountId}:${subscriptionId}:${actionType}`;
}
