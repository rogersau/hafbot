import type {
  BillingAuditIdentity,
  BillingLedgerOperation,
  BillingSubscriptionProjection,
} from "./types";

export interface BillingGuildAssignment {
  guildId: string;
  ownerId: string;
  subscriptionId: string;
  assignedAtMs: number;
}

export interface EligibleBillingGuild {
  guildId: string;
  name: string;
  icon: string | null;
  effectivePlan: "free" | "premium" | "premium_plus";
}

export interface BillingAssignmentStore {
  readProjection(ownerId: string): Promise<BillingSubscriptionProjection | null>;
  listAssignments(ownerId: string): Promise<BillingGuildAssignment[]>;
  readEffectivePlans?(
    guildIds: string[],
  ): Promise<Map<string, "free" | "premium" | "premium_plus">>;
  assign(input: {
    ownerId: string;
    subscriptionId: string;
    guildId: string;
    plan: "premium" | "premium_plus";
    capacity: number;
    nowMs: number;
    operation?: BillingLedgerOperation;
  }): Promise<boolean>;
  move(input: {
    ownerId: string;
    subscriptionId: string;
    fromGuildId: string;
    toGuildId: string;
    plan: "premium" | "premium_plus";
    nowMs: number;
    operation?: BillingLedgerOperation;
  }): Promise<boolean>;
  unassign(input: {
    ownerId: string;
    subscriptionId: string;
    guildId: string;
    nowMs: number;
    operation?: BillingLedgerOperation;
  }): Promise<boolean>;
}

export type BillingAssignmentActor = BillingAuditIdentity;

export interface BillingAssignmentService {
  read(
    ownerId: string,
    discordUserId: string,
  ): Promise<{
    assignments: BillingGuildAssignment[];
    eligibleGuilds: EligibleBillingGuild[];
    capacity: number;
  }>;
  assign(ownerId: string, actor: BillingAssignmentActor, guildId: string): Promise<void>;
  move(
    ownerId: string,
    actor: BillingAssignmentActor,
    fromGuildId: string,
    toGuildId: string,
  ): Promise<void>;
  unassign(ownerId: string, actor: BillingAssignmentActor, guildId: string): Promise<void>;
}

export function createBillingAssignmentService(options: {
  store: BillingAssignmentStore;
  listEligibleGuilds(
    ownerId: string,
    discordUserId: string,
  ): Promise<Array<Omit<EligibleBillingGuild, "effectivePlan">>>;
  resolveGuildName?(guildId: string): Promise<string | null>;
  billingUrl?: string;
  now?: () => number;
  createId?: () => string;
}): BillingAssignmentService {
  const now = options.now ?? Date.now;
  const createId = options.createId ?? (() => crypto.randomUUID());
  async function context(ownerId: string) {
    const projection = await options.store.readProjection(ownerId);
    if (
      !projection?.subscriptionId ||
      (projection.plan !== "premium" && projection.plan !== "premium_plus")
    ) {
      throw new AssignmentError("usable_subscription_required", 409);
    }
    if (projection.quarantineReason) throw new AssignmentError("billing_quarantined", 409);
    return { projection, capacity: projection.plan === "premium_plus" ? 3 : 1 };
  }
  async function requireEligible(ownerId: string, discordUserId: string, guildId: string) {
    const eligible = await options.listEligibleGuilds(ownerId, discordUserId);
    const guild = eligible.find((candidate) => candidate.guildId === guildId);
    if (!guild) {
      throw new AssignmentError("guild_not_currently_manageable_or_installed", 403);
    }
    return guild;
  }
  function operation(input: {
    ownerId: string;
    actor: BillingAssignmentActor;
    kind: "guild_assignment_assigned" | "guild_assignment_unassigned" | "guild_assignment_moved";
    plan: "premium" | "premium_plus";
    effectiveAtMs: number;
    guild?: { guildId: string; name: string };
    fromGuild?: { guildId: string; name: string };
    toGuild?: { guildId: string; name: string };
  }): BillingLedgerOperation {
    return {
      id: createId(),
      ownerId: input.ownerId,
      kind: input.kind,
      source: "dashboard",
      correlationId: null,
      summaryJson: JSON.stringify({
        summary:
          input.kind === "guild_assignment_assigned"
            ? "Guild assigned to Subscription"
            : input.kind === "guild_assignment_unassigned"
              ? "Guild removed from Subscription"
              : "Guild Assignment moved",
        resultingAccess: input.plan,
        effectiveAtMs: input.effectiveAtMs,
        requiredAction: null,
        billingPath: options.billingUrl ?? "/admin/billing",
        notifyOwner: true,
        eventType: "guild_assignment",
        plan: input.plan,
        owner: input.actor,
        actor: input.actor,
        guild: input.guild,
        fromGuild: input.fromGuild,
        toGuild: input.toGuild,
      }),
      createdAtMs: input.effectiveAtMs,
    };
  }
  return {
    async read(ownerId, discordUserId) {
      const { capacity } = await context(ownerId);
      const [assignments, discoveredGuilds] = await Promise.all([
        options.store.listAssignments(ownerId),
        options.listEligibleGuilds(ownerId, discordUserId),
      ]);
      const effectivePlans = options.store.readEffectivePlans
        ? await options.store.readEffectivePlans(discoveredGuilds.map((guild) => guild.guildId))
        : new Map<string, "free" | "premium" | "premium_plus">();
      const eligibleGuilds = discoveredGuilds.map((guild) => ({
        ...guild,
        effectivePlan: effectivePlans.get(guild.guildId) ?? "free",
      }));
      return { assignments, eligibleGuilds, capacity };
    },
    async assign(ownerId, actor, guildId) {
      const { projection, capacity } = await context(ownerId);
      if (projection.status !== "active")
        throw new AssignmentError("new_assignment_blocked_during_grace", 409);
      const guild = await requireEligible(ownerId, actor.discordUserId, guildId);
      const changedAtMs = now();
      const auditOperation = operation({
        ownerId,
        actor,
        kind: "guild_assignment_assigned",
        plan: projection.plan as "premium" | "premium_plus",
        effectiveAtMs: changedAtMs,
        guild: { guildId, name: guild.name },
      });
      if (
        !(await options.store.assign({
          ownerId,
          subscriptionId: projection.subscriptionId!,
          guildId,
          plan: projection.plan as "premium" | "premium_plus",
          capacity,
          nowMs: changedAtMs,
          operation: auditOperation,
        }))
      ) {
        throw new AssignmentError("assignment_conflict_or_capacity_exceeded", 409);
      }
    },
    async move(ownerId, actor, fromGuildId, toGuildId) {
      const { projection } = await context(ownerId);
      if (projection.status !== "active")
        throw new AssignmentError("assignment_move_blocked_during_grace", 409);
      const [fromGuildName, toGuild] = await Promise.all([
        options.resolveGuildName?.(fromGuildId) ?? Promise.resolve(null),
        requireEligible(ownerId, actor.discordUserId, toGuildId),
      ]);
      const changedAtMs = now();
      const auditOperation = operation({
        ownerId,
        actor,
        kind: "guild_assignment_moved",
        plan: projection.plan as "premium" | "premium_plus",
        effectiveAtMs: changedAtMs,
        fromGuild: { guildId: fromGuildId, name: fromGuildName ?? fromGuildId },
        toGuild: { guildId: toGuildId, name: toGuild.name },
      });
      if (
        !(await options.store.move({
          ownerId,
          subscriptionId: projection.subscriptionId!,
          fromGuildId,
          toGuildId,
          plan: projection.plan as "premium" | "premium_plus",
          nowMs: changedAtMs,
          operation: auditOperation,
        }))
      ) {
        throw new AssignmentError("assignment_move_conflict", 409);
      }
    },
    async unassign(ownerId, actor, guildId) {
      const { projection } = await context(ownerId);
      const guildName = await options.resolveGuildName?.(guildId);
      const changedAtMs = now();
      const auditOperation = operation({
        ownerId,
        actor,
        kind: "guild_assignment_unassigned",
        plan: projection.plan as "premium" | "premium_plus",
        effectiveAtMs: changedAtMs,
        guild: { guildId, name: guildName ?? guildId },
      });
      if (
        !(await options.store.unassign({
          ownerId,
          subscriptionId: projection.subscriptionId!,
          guildId,
          nowMs: changedAtMs,
          operation: auditOperation,
        }))
      ) {
        throw new AssignmentError("assignment_not_found", 404);
      }
    },
  };
}

export class AssignmentError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}
