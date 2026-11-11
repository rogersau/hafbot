import type { GuildNotificationChannelStore } from "../runtime/contracts";
import type { TimedRoleStore, GuildAuditLogStore } from "../runtime/contracts";
import type { TimedRoleAssignment, TimedRoleAutomationRule } from "../types";
import { DiscordApiError } from "../discord";
import {
  GuildResourceValidationError,
  type GuildResourceScope,
  type GuildResourceValidator,
} from "../discord/guild-resource-validator";
import type { CreateChannelMessageInput } from "../discord/messages";
import { assignTimedRole as assignTimedRoleWorkflow } from "./timed-roles/assign-timed-role";
import {
  readTimedRoleWorkflow,
  transitionTimedRoleWorkflow,
  uniqueRoleIds,
  type TimedRoleWorkflow,
  type TimedRoleWorkflowEffect,
} from "./timed-roles/workflow";
import { parseTimedRoleDuration } from "../timed-roles";
import {
  buildTimedRoleUpdateMessage,
  buildTimedRoleRestorationFailureMessage,
  postGuildActivityUpdate,
  type ChannelMessageSender,
  type ActionActor,
} from "./activity-log";

export interface TimedRoleKey {
  guildId: string;
  userId: string;
  roleId: string;
  targetDisplayName?: string | null;
  durationInput?: string;
  expiresAtMs?: number;
  suspendedRoleIds?: string[];
  pendingSuspensionRoleIds?: string[];
  removedRoleIds?: string[];
  pendingRestorationRoleIds?: string[];
  restorationStartedAtMs?: number | null;
  targetRoleRemovalCompletedAtMs?: number | null;
}

export interface TimedRoleDmContext {
  guildName?: string | null;
  roleName?: string | null;
}

export interface TimedRoleOperationRunner {
  run(handlerKey: string, operation: () => Promise<unknown>): Promise<boolean>;
  hasStarted(handlerKey: string): Promise<boolean>;
}

interface TimedRoleRestorationOutcome {
  completed: boolean;
  failedRoleIds: string[];
  retryReason: "target-role" | "suspended-roles" | "persistence" | null;
  failure?: unknown;
}

export class TimedRoleService {
  constructor(
    private readonly store: TimedRoleStore,
    _botToken: string,
    private readonly guildResources: GuildResourceValidator,
    private readonly addRoleToMember?: (
      guildId: string,
      userId: string,
      roleId: string,
    ) => Promise<void>,
    private readonly removeRoleFromMember?: (
      guildId: string,
      userId: string,
      roleId: string,
    ) => Promise<void>,
    private readonly notificationStore?: Partial<GuildNotificationChannelStore>,
    private readonly sendChannelMessage?: ChannelMessageSender,
    private readonly sendUserDm?: (
      userId: string,
      body: CreateChannelMessageInput,
    ) => Promise<void>,
    private readonly resolveDmContext?: (
      assignment: TimedRoleAssignment,
    ) => Promise<TimedRoleDmContext>,
    private readonly resolveFooterText?: (guildId: string) => Promise<string>,
    private readonly auditLogStore?: GuildAuditLogStore,
    private readonly operations?: TimedRoleOperationRunner,
    private readonly deriveMessageNonce?: (
      kind: "dm" | "audit",
      assignment: TimedRoleAssignment,
      destinationId: string,
    ) => string,
    private readonly readMemberRoleIds?: (guildId: string, userId: string) => Promise<string[]>,
    private readonly readBotRoleIds?: (guildId: string) => Promise<string[]>,
  ) {}

  async assignTimedRole(assignment: TimedRoleAssignment, actor?: ActionActor): Promise<void> {
    const resources = await this.guildResources.forGuild(assignment.guildId);
    resources.requireRole(assignment.roleId);
    if ((assignment.suspendedRoleIds?.length ?? 0) > 0) {
      const scope = assignmentOperationScope(assignment);
      const runAssignment = () => this.assignTimedRoleWithSuspension(assignment, resources);
      if (this.operations) {
        await this.operations.run(`${scope}:roles-and-persist`, runAssignment);
        await this.operations.run(`${scope}:dm`, () => this.sendAssignmentDm(assignment));
        await this.operations.run(`${scope}:audit`, () =>
          this.postAssignmentUpdate(assignment, actor, true),
        );
      } else {
        await runAssignment();
        await this.sendAssignmentDm(assignment);
        await this.postAssignmentUpdate(assignment, actor);
      }
      return;
    }
    if (this.operations) {
      const scope = assignmentOperationScope(assignment);
      if (this.addRoleToMember) {
        await this.operations.run(`${scope}:role`, () =>
          this.addRoleToMember!(assignment.guildId, assignment.userId, assignment.roleId),
        );
      }
      await this.operations.run(`${scope}:persist`, () => this.store.upsertTimedRole(assignment));
      await this.operations.run(`${scope}:dm`, () => this.sendAssignmentDm(assignment));
      await this.operations.run(`${scope}:audit`, () =>
        this.postUpdate(
          assignment.guildId,
          buildTimedRoleUpdateMessage({
            action: "add",
            actor,
            userId: assignment.userId,
            targetDisplayName: assignment.targetDisplayName,
            roleId: assignment.roleId,
            durationInput: assignment.durationInput,
            expiresAtMs: assignment.expiresAtMs,
          }),
          "timed-role.assignment",
          assignment,
        ),
      );
      return;
    }
    if (!this.addRoleToMember) {
      await this.store.upsertTimedRole(assignment);
      await this.postUpdate(
        assignment.guildId,
        buildTimedRoleUpdateMessage({
          action: "add",
          actor,
          userId: assignment.userId,
          targetDisplayName: assignment.targetDisplayName,
          roleId: assignment.roleId,
          durationInput: assignment.durationInput,
          expiresAtMs: assignment.expiresAtMs,
        }),
        "timed-role.assignment",
      );
      return;
    }

    await assignTimedRoleWorkflow(this.store, this.addRoleToMember, assignment);
    await this.sendAssignmentDm(assignment);
    await this.postUpdate(
      assignment.guildId,
      buildTimedRoleUpdateMessage({
        action: "add",
        actor,
        userId: assignment.userId,
        targetDisplayName: assignment.targetDisplayName,
        roleId: assignment.roleId,
        durationInput: assignment.durationInput,
        expiresAtMs: assignment.expiresAtMs,
      }),
      "timed-role.assignment",
    );
  }

  private async assignTimedRoleWithSuspension(
    assignment: TimedRoleAssignment,
    resources: GuildResourceScope,
  ): Promise<void> {
    if (
      !this.addRoleToMember ||
      !this.removeRoleFromMember ||
      !this.readMemberRoleIds ||
      !this.readBotRoleIds
    ) {
      throw new Error("Timed role suspension is not available in this runtime.");
    }

    const selectedRoleIds = uniqueRoleIds(assignment.suspendedRoleIds ?? []);
    resources.requireRoles(selectedRoleIds);
    const [memberRoleIds, botRoleIds] = await Promise.all([
      this.readMemberRoleIds(assignment.guildId, assignment.userId),
      this.readBotRoleIds(assignment.guildId),
    ]);
    const memberRoles = new Set(memberRoleIds);
    const rolesById = new Map(resources.roles.map((role) => [role.id, role]));
    const highestBotPosition = Math.max(
      -1,
      ...botRoleIds.map((roleId) => rolesById.get(roleId)?.position ?? -1),
    );
    const targetRole = resources.requireRole(assignment.roleId);
    if (
      targetRole.id === assignment.guildId ||
      targetRole.managed === true ||
      targetRole.position >= highestBotPosition
    ) {
      throw new GuildResourceValidationError("role");
    }

    const suspendWhileActive = selectedRoleIds.filter((roleId) => {
      const role = rolesById.get(roleId)!;
      return (
        role.id !== assignment.guildId &&
        role.id !== assignment.roleId &&
        role.managed !== true &&
        role.position < highestBotPosition
      );
    });
    const rolesToRemove = suspendWhileActive.filter((roleId) => memberRoles.has(roleId));
    const targetWasHeld = memberRoles.has(assignment.roleId);

    const existing = (await this.store.listTimedRolesByGuild(assignment.guildId)).find(
      (candidate) =>
        candidate.userId === assignment.userId && candidate.roleId === assignment.roleId,
    );
    if (existing) {
      let workflow: TimedRoleWorkflow = readTimedRoleWorkflow(existing);
      if (workflow.kind !== "active" && workflow.kind !== "suspending") {
        throw new Error(
          "This timed role is already being removed. Wait for restoration to finish before assigning it again.",
        );
      }
      if (!targetWasHeld) {
        await this.addRoleToMember(assignment.guildId, assignment.userId, assignment.roleId);
      }
      for (const roleId of workflow.pendingSuspensionRoleIds) {
        const role = rolesById.get(roleId);
        if (
          !role ||
          role.id === assignment.guildId ||
          role.managed === true ||
          role.position >= highestBotPosition
        ) {
          throw new GuildResourceValidationError("role");
        }
        if (memberRoles.has(roleId)) {
          await this.removeRoleFromMember(assignment.guildId, assignment.userId, roleId);
          memberRoles.delete(roleId);
        }
        const transition = transitionTimedRoleWorkflow(workflow, {
          type: "suspension-confirmed",
          roleId,
        });
        workflow = transition.state;
        await this.applyWorkflowEffects(assignment, transition.effects);
      }
      for (const roleId of uniqueRoleIds(existing.removedRoleIds ?? [])) {
        if (!memberRoles.has(roleId)) continue;
        const role = rolesById.get(roleId);
        if (
          !role ||
          role.id === assignment.guildId ||
          role.managed === true ||
          role.position >= highestBotPosition
        ) {
          throw new GuildResourceValidationError("role");
        }
        await this.removeRoleFromMember(assignment.guildId, assignment.userId, roleId);
        memberRoles.delete(roleId);
      }
      await this.store.upsertTimedRole({
        ...existing,
        durationInput: assignment.durationInput,
        expiresAtMs: assignment.expiresAtMs,
        ...(assignment.targetDisplayName !== undefined
          ? { targetDisplayName: assignment.targetDisplayName }
          : {}),
      });
      return;
    }

    let workflow: TimedRoleWorkflow = readTimedRoleWorkflow({
      suspendedRoleIds: suspendWhileActive,
      pendingSuspensionRoleIds: rolesToRemove,
      removedRoleIds: [],
      pendingRestorationRoleIds: [],
    });
    let targetAdded = false;
    let snapshotPersisted = false;
    let uncertainRemovalRoleId: string | undefined;

    try {
      if (!targetWasHeld) {
        await this.addRoleToMember(assignment.guildId, assignment.userId, assignment.roleId);
        targetAdded = true;
      }
      await this.store.upsertTimedRole({
        ...assignment,
        suspendedRoleIds: suspendWhileActive,
        pendingSuspensionRoleIds: rolesToRemove,
        removedRoleIds: [],
        pendingRestorationRoleIds: [],
      });
      snapshotPersisted = true;
      for (const roleId of rolesToRemove) {
        // A transport failure can follow a committed Discord DELETE.
        uncertainRemovalRoleId = roleId;
        await this.removeRoleFromMember(assignment.guildId, assignment.userId, roleId);
        const transition = transitionTimedRoleWorkflow(workflow, {
          type: "suspension-confirmed",
          roleId,
        });
        workflow = transition.state;
        uncertainRemovalRoleId = undefined;
        await this.applyWorkflowEffects(assignment, transition.effects);
      }
    } catch (error) {
      let compensation = transitionTimedRoleWorkflow(workflow, {
        type: "compensation-requested",
        targetRoleRemovalRequired: targetAdded,
        uncertainRemovalRoleId,
      }).state;
      if (compensation.kind !== "compensating") throw new Error("Invalid timed role compensation.");
      let compensationFailed = false;
      if (snapshotPersisted) {
        try {
          await this.store.upsertTimedRole({
            ...assignment,
            expiresAtMs: Math.min(assignment.expiresAtMs, Date.now()),
          });
          await this.store.updateTimedRoleSuspension({
            guildId: assignment.guildId,
            userId: assignment.userId,
            roleId: assignment.roleId,
            pendingSuspensionRoleIds: [],
            removedRoleIds: compensation.removedRoleIds,
            pendingRestorationRoleIds: compensation.pendingRestorationRoleIds,
          });
        } catch {
          // Compensation still proceeds; a successful delete removes any stale operation state.
        }
      }
      for (const roleId of [...compensation.removedRoleIds].reverse()) {
        try {
          await this.addRoleToMember(assignment.guildId, assignment.userId, roleId);
          const transition = transitionTimedRoleWorkflow(compensation, {
            type: "compensation-role-restored",
            roleId,
          });
          if (transition.state.kind !== "compensating") {
            throw new Error("Invalid timed role compensation.");
          }
          compensation = transition.state;
        } catch {
          compensationFailed = true;
        }
      }
      if (compensation.targetRoleRemovalRequired) {
        try {
          await this.removeRoleFromMember(assignment.guildId, assignment.userId, assignment.roleId);
          const transition = transitionTimedRoleWorkflow(compensation, {
            type: "compensation-target-removed",
          });
          if (transition.state.kind !== "compensating") {
            throw new Error("Invalid timed role compensation.");
          }
          compensation = transition.state;
        } catch {
          compensationFailed = true;
        }
      }
      if (!compensationFailed) {
        const finished = transitionTimedRoleWorkflow(compensation, {
          type: "compensation-finished",
          snapshotPersisted,
        });
        try {
          await this.applyWorkflowEffects(assignment, finished.effects);
        } catch {
          compensationFailed = true;
        }
      }
      if (compensationFailed) {
        try {
          await this.store.upsertTimedRole({
            ...assignment,
            expiresAtMs: Math.min(assignment.expiresAtMs, Date.now()),
            suspendedRoleIds: suspendWhileActive,
            pendingSuspensionRoleIds: [],
            removedRoleIds: compensation.removedRoleIds,
            pendingRestorationRoleIds: compensation.pendingRestorationRoleIds,
          });
          if (snapshotPersisted) {
            await this.store.updateTimedRoleSuspension({
              guildId: assignment.guildId,
              userId: assignment.userId,
              roleId: assignment.roleId,
              pendingSuspensionRoleIds: [],
              removedRoleIds: compensation.removedRoleIds,
              pendingRestorationRoleIds: compensation.pendingRestorationRoleIds,
            });
          }
        } catch {
          // The caller receives the same explicit rollback failure either way.
        }
        throw new Error("Failed to assign the timed role, and rollback failed.");
      }
      throw error;
    }
  }

  private async postAssignmentUpdate(
    assignment: TimedRoleAssignment,
    actor?: ActionActor,
    withNonce = false,
  ): Promise<void> {
    await this.postUpdate(
      assignment.guildId,
      buildTimedRoleUpdateMessage({
        action: "add",
        actor,
        userId: assignment.userId,
        targetDisplayName: assignment.targetDisplayName,
        roleId: assignment.roleId,
        durationInput: assignment.durationInput,
        expiresAtMs: assignment.expiresAtMs,
      }),
      "timed-role.assignment",
      withNonce ? assignment : undefined,
    );
  }

  async removeTimedRole(key: TimedRoleKey, actor?: ActionActor): Promise<void> {
    if (hasSuspensionSnapshot(key)) {
      const assignment: TimedRoleAssignment = {
        guildId: key.guildId,
        userId: key.userId,
        roleId: key.roleId,
        durationInput: key.durationInput ?? "",
        expiresAtMs: key.expiresAtMs ?? 0,
        ...(key.targetDisplayName != null ? { targetDisplayName: key.targetDisplayName } : {}),
        suspendedRoleIds: key.suspendedRoleIds,
        pendingSuspensionRoleIds: key.pendingSuspensionRoleIds,
        removedRoleIds: key.removedRoleIds,
        pendingRestorationRoleIds: key.pendingRestorationRoleIds,
        restorationStartedAtMs: key.restorationStartedAtMs,
        targetRoleRemovalCompletedAtMs: key.targetRoleRemovalCompletedAtMs,
      };
      const outcome = await this.restoreSuspendedRoles(assignment, Date.now());
      if (outcome.retryReason) {
        await this.postRestorationFailure(assignment, outcome);
        throw new Error("Failed to restore one or more suspended roles.");
      }
      await this.postUpdate(
        key.guildId,
        buildTimedRoleUpdateMessage({
          action: "remove",
          actor,
          userId: key.userId,
          targetDisplayName: key.targetDisplayName,
          roleId: key.roleId,
          durationInput: key.durationInput,
          expiresAtMs: key.expiresAtMs,
        }),
        "timed-role.removal",
      );
      return;
    }

    await this.guildResources.requireRole(key.guildId, key.roleId);
    if (this.removeRoleFromMember) {
      await this.removeRoleFromMember(key.guildId, key.userId, key.roleId);
    }

    await this.store.deleteTimedRole(key);
    await this.postUpdate(
      key.guildId,
      buildTimedRoleUpdateMessage({
        action: "remove",
        actor,
        userId: key.userId,
        targetDisplayName: key.targetDisplayName,
        roleId: key.roleId,
        durationInput: key.durationInput,
        expiresAtMs: key.expiresAtMs,
      }),
      "timed-role.removal",
    );
  }

  async listTimedRoles(guildId: string): Promise<TimedRoleAssignment[]> {
    return this.store.listTimedRolesByGuild(guildId);
  }

  async getManageableGuildResources(guildId: string): Promise<{
    roles: Array<{ id: string; name: string }>;
    channels: Array<{ id: string; name: string; type: number }>;
  }> {
    if (!this.readBotRoleIds) {
      throw new Error("Timed role role management is not available in this runtime.");
    }
    const resources = await this.guildResources.forGuild(guildId);
    const rolesById = new Map(resources.roles.map((role) => [role.id, role]));
    const botRoleIds = await this.readBotRoleIds(guildId);
    const highestBotPosition = Math.max(
      -1,
      ...botRoleIds.map((roleId) => rolesById.get(roleId)?.position ?? -1),
    );
    return {
      roles: resources.roles
        .filter(
          (role) =>
            role.id !== guildId && role.managed !== true && role.position < highestBotPosition,
        )
        .map(({ id, name }) => ({ id, name })),
      channels: resources.channels.map(({ id, name, type }) => ({ id, name, type })),
    };
  }

  async restoreActiveTimedRolesForMember(input: {
    guildId: string;
    userId: string;
    nowMs?: number;
  }): Promise<TimedRoleAssignment[]> {
    if (!this.addRoleToMember) {
      return [];
    }

    const nowMs = input.nowMs ?? Date.now();
    const assignments = (await this.store.listTimedRolesByGuild(input.guildId)).filter(
      (assignment) => assignment.userId === input.userId && assignment.expiresAtMs > nowMs,
    );

    const resources = await this.guildResources.forGuild(input.guildId);
    resources.requireRoles(assignments.map((assignment) => assignment.roleId));
    for (const assignment of assignments) {
      await this.addRoleToMember(assignment.guildId, assignment.userId, assignment.roleId);
    }

    return assignments;
  }

  async expireDueTimedRoles(nowMs = Date.now()): Promise<void> {
    if (!this.removeRoleFromMember) {
      return;
    }

    const expiredRoles = await this.store.listExpiredTimedRoles(nowMs);
    for (const role of expiredRoles) {
      try {
        if (hasSuspensionSnapshot(role)) {
          const outcome = await this.restoreSuspendedRoles(role, nowMs);
          if (outcome.retryReason) {
            console.error("Failed to restore suspended timed roles", {
              guildId: role.guildId,
              userId: role.userId,
              roleId: role.roleId,
              failedRoleIds: outcome.failedRoleIds,
              retryReason: outcome.retryReason,
              ...(outcome.failure instanceof Error ? { failure: outcome.failure.message } : {}),
            });
            await this.postRestorationFailure(role, outcome);
            continue;
          }
          if (!outcome.completed) continue;
          await this.postUpdate(
            role.guildId,
            buildTimedRoleUpdateMessage({
              action: "expire",
              userId: role.userId,
              targetDisplayName: role.targetDisplayName,
              roleId: role.roleId,
              expiresAtMs: role.expiresAtMs,
            }),
            "timed-role.expiry",
          );
          continue;
        }

        await this.guildResources.requireRole(role.guildId, role.roleId);
        try {
          await this.removeRoleFromMember(role.guildId, role.userId, role.roleId);
        } catch (error) {
          if (!(error instanceof DiscordApiError) || error.status !== 404) {
            throw error;
          }
        }
        await this.store.deleteTimedRole({
          guildId: role.guildId,
          userId: role.userId,
          roleId: role.roleId,
        });
        await this.postUpdate(
          role.guildId,
          buildTimedRoleUpdateMessage({
            action: "expire",
            userId: role.userId,
            targetDisplayName: role.targetDisplayName,
            roleId: role.roleId,
            expiresAtMs: role.expiresAtMs,
          }),
          "timed-role.expiry",
        );
      } catch (error) {
        console.error("Failed to remove expired timed role", error);
      }
    }
  }

  private async restoreSuspendedRoles(
    assignment: TimedRoleAssignment,
    nowMs: number,
  ): Promise<TimedRoleRestorationOutcome> {
    if (!this.addRoleToMember || !this.removeRoleFromMember || !this.readBotRoleIds) {
      throw new Error("Timed role restoration is not available in this runtime.");
    }

    const requested = transitionTimedRoleWorkflow(readTimedRoleWorkflow(assignment), {
      type: "restoration-requested",
      nowMs,
    });
    await this.applyWorkflowEffects(assignment, requested.effects);
    let workflow = requested.state;
    if (
      workflow.kind !== "removing-target" &&
      workflow.kind !== "restoring-roles" &&
      workflow.kind !== "ready-to-delete"
    ) {
      throw new Error("Invalid timed role restoration.");
    }
    const pendingRoleIds = workflow.pendingRestorationRoleIds;

    let resources: GuildResourceScope;
    let botRoleIds: string[];
    try {
      [resources, botRoleIds] = await Promise.all([
        this.guildResources.forGuild(assignment.guildId),
        this.readBotRoleIds(assignment.guildId),
      ]);
    } catch (failure) {
      return {
        completed: false,
        failedRoleIds: pendingRoleIds,
        retryReason: workflow.kind === "removing-target" ? "target-role" : "suspended-roles",
        failure,
      };
    }

    const rolesById = new Map(resources.roles.map((role) => [role.id, role]));
    const highestBotPosition = Math.max(
      -1,
      ...botRoleIds.map((roleId) => rolesById.get(roleId)?.position ?? -1),
    );

    if (workflow.kind === "removing-target") {
      const targetRole = rolesById.get(assignment.roleId);
      if (targetRole) {
        if (
          targetRole.id === assignment.guildId ||
          targetRole.managed === true ||
          targetRole.position >= highestBotPosition
        ) {
          return {
            completed: false,
            failedRoleIds: [],
            retryReason: "target-role",
            failure: new GuildResourceValidationError("role"),
          };
        }
        try {
          await this.removeRoleFromMember(assignment.guildId, assignment.userId, assignment.roleId);
        } catch (error) {
          if (!(error instanceof DiscordApiError) || error.status !== 404) {
            return {
              completed: false,
              failedRoleIds: [],
              retryReason: "target-role",
              failure: error,
            };
          }
        }
      }
      const confirmed = transitionTimedRoleWorkflow(workflow, {
        type: "target-removal-confirmed",
        nowMs,
      });
      try {
        await this.applyWorkflowEffects(assignment, confirmed.effects);
      } catch (failure) {
        return {
          completed: false,
          failedRoleIds: [],
          retryReason: "target-role",
          failure,
        };
      }
      if (
        confirmed.state.kind !== "restoring-roles" &&
        confirmed.state.kind !== "ready-to-delete"
      ) {
        throw new Error("Invalid timed role restoration.");
      }
      workflow = confirmed.state;
    }

    let assignments: TimedRoleAssignment[];
    try {
      assignments = await this.store.listTimedRolesByGuild(assignment.guildId);
    } catch (failure) {
      return {
        completed: false,
        failedRoleIds: pendingRoleIds,
        retryReason: "persistence",
        failure,
      };
    }
    const remainingRoleIds: string[] = [];
    const failedRoleIds: string[] = [];

    for (const roleId of pendingRoleIds) {
      const blockedByActiveAssignment = assignments.some(
        (other) =>
          other.userId === assignment.userId &&
          other.roleId !== assignment.roleId &&
          other.expiresAtMs > nowMs &&
          other.restorationStartedAtMs == null &&
          (other.suspendedRoleIds ?? []).includes(roleId),
      );
      if (blockedByActiveAssignment) {
        remainingRoleIds.push(roleId);
        continue;
      }

      const role = rolesById.get(roleId);
      if (!role) continue;
      if (
        role.id === assignment.guildId ||
        role.managed === true ||
        role.position >= highestBotPosition
      ) {
        remainingRoleIds.push(roleId);
        failedRoleIds.push(roleId);
        continue;
      }

      try {
        await this.addRoleToMember(assignment.guildId, assignment.userId, roleId);
      } catch (error) {
        if (error instanceof DiscordApiError && error.status === 404) continue;
        remainingRoleIds.push(roleId);
        failedRoleIds.push(roleId);
      }
    }

    const attempted = transitionTimedRoleWorkflow(workflow, {
      type: "restoration-attempted",
      remainingRoleIds,
    });
    try {
      await this.applyWorkflowEffects(assignment, attempted.effects);
    } catch (failure) {
      return {
        completed: false,
        failedRoleIds: remainingRoleIds,
        retryReason: "persistence",
        failure,
      };
    }
    return {
      completed: attempted.state.kind === "completed",
      failedRoleIds,
      retryReason: failedRoleIds.length > 0 ? "suspended-roles" : null,
    };
  }

  private async applyWorkflowEffects(
    assignment: TimedRoleAssignment,
    effects: TimedRoleWorkflowEffect[],
  ): Promise<void> {
    const key = {
      guildId: assignment.guildId,
      userId: assignment.userId,
      roleId: assignment.roleId,
    };
    for (const effect of effects) {
      switch (effect.type) {
        case "persist-suspension":
          await this.store.updateTimedRoleSuspension({
            ...key,
            pendingSuspensionRoleIds: effect.progress.pendingSuspensionRoleIds,
            removedRoleIds: effect.progress.removedRoleIds,
            pendingRestorationRoleIds: effect.progress.pendingRestorationRoleIds,
          });
          break;
        case "persist-restoration":
          await this.store.updateTimedRoleRestoration({ ...key, ...effect.progress });
          break;
        case "delete-assignment":
          await this.store.deleteTimedRole(key);
          break;
        default: {
          const unexpected: never = effect;
          throw new Error(`Unknown timed role workflow effect: ${unexpected}`);
        }
      }
    }
  }

  private async postRestorationFailure(
    assignment: TimedRoleAssignment,
    outcome: Pick<TimedRoleRestorationOutcome, "failedRoleIds" | "retryReason">,
  ): Promise<void> {
    await this.postUpdate(
      assignment.guildId,
      buildTimedRoleRestorationFailureMessage({
        userId: assignment.userId,
        targetDisplayName: assignment.targetDisplayName,
        roleId: assignment.roleId,
        failedRoleIds: outcome.failedRoleIds,
        targetRoleRemovalPending: outcome.retryReason === "target-role",
      }),
      "timed-role.removal",
    );
  }

  async getNewMemberTimedRoleConfig(guildId: string) {
    return (
      this.store.readNewMemberTimedRoleConfig?.(guildId) ?? {
        guildId,
        roles: [],
      }
    );
  }

  async updateNewMemberTimedRoleConfig(input: {
    guildId: string;
    roles: TimedRoleAutomationRule[];
  }): Promise<void> {
    const resources = await this.guildResources.forGuild(input.guildId);
    await this.validateAutomationRules(resources, input.roles);
    if (this.store.upsertTimedRoleConfigRules) {
      await this.store.upsertTimedRoleConfigRules(input.guildId, "new-member", input.roles);
      return;
    }
    await this.store.upsertNewMemberTimedRoleConfig?.(input);
  }

  async getManualAssignmentTimedRoleConfig(guildId: string) {
    return (
      this.store.readManualAssignmentTimedRoleConfig?.(guildId) ?? {
        guildId,
        roles: [],
      }
    );
  }

  async updateManualAssignmentTimedRoleConfig(input: {
    guildId: string;
    roles: TimedRoleAutomationRule[];
  }): Promise<void> {
    const resources = await this.guildResources.forGuild(input.guildId);
    await this.validateAutomationRules(resources, input.roles);
    if (this.store.upsertTimedRoleConfigRules) {
      await this.store.upsertTimedRoleConfigRules(input.guildId, "manual-assignment", input.roles);
      return;
    }
    await this.store.upsertManualAssignmentTimedRoleConfig?.(input);
  }

  async assignConfiguredNewMemberRole(input: {
    guildId: string;
    userId: string;
    targetDisplayName?: string | null;
    nowMs?: number;
  }): Promise<TimedRoleAssignment[] | null> {
    const config = await this.getNewMemberTimedRoleConfig(input.guildId);
    const rules = readTimedRoleAutomationRules(config);
    if (rules.length === 0) {
      return null;
    }

    const assignments: TimedRoleAssignment[] = [];
    const nowMs = input.nowMs ?? Date.now();
    const existingAssignments = await this.store.listTimedRolesByGuild(input.guildId);
    for (const rule of rules) {
      const existing = existingAssignments.find(
        (assignment) =>
          assignment.userId === input.userId &&
          assignment.roleId === rule.roleId &&
          assignment.expiresAtMs > nowMs,
      );
      if (existing) {
        const scope = assignmentOperationScope(existing);
        if (
          !this.operations ||
          (!(await this.operations.hasStarted(`${scope}:persist`)) &&
            !(await this.operations.hasStarted(`${scope}:roles-and-persist`)))
        )
          continue;
        await this.assignTimedRole(existing, { label: "New member automation" });
        assignments.push(existing);
        continue;
      }

      const parsedDuration = parseTimedRoleDuration(rule.durationInput, nowMs);
      if (!parsedDuration) {
        continue;
      }

      const assignment: TimedRoleAssignment = {
        guildId: input.guildId,
        userId: input.userId,
        roleId: rule.roleId,
        durationInput: parsedDuration.durationInput,
        expiresAtMs: parsedDuration.expiresAtMs,
        ...(rule.suspendedRoleIds?.length
          ? { suspendedRoleIds: uniqueRoleIds(rule.suspendedRoleIds) }
          : {}),
        ...(input.targetDisplayName != null ? { targetDisplayName: input.targetDisplayName } : {}),
      };

      await this.assignTimedRole(assignment, { label: "New member automation" });
      assignments.push(assignment);
    }

    return assignments.length > 0 ? assignments : null;
  }

  async createManualAssignmentTimedRole(input: {
    guildId: string;
    userId: string;
    roleIds: string[];
    targetDisplayName?: string | null;
    nowMs?: number;
  }): Promise<TimedRoleAssignment[] | null> {
    const config = await this.getManualAssignmentTimedRoleConfig(input.guildId);
    const rules = readTimedRoleAutomationRules(config).filter((entry) =>
      input.roleIds.includes(entry.roleId),
    );
    if (rules.length === 0) {
      return null;
    }

    const nowMs = input.nowMs ?? Date.now();
    const existingAssignments = await this.store.listTimedRolesByGuild(input.guildId);
    const assignments: TimedRoleAssignment[] = [];
    for (const rule of rules) {
      const existing = existingAssignments.find(
        (assignment) =>
          assignment.userId === input.userId &&
          assignment.roleId === rule.roleId &&
          assignment.expiresAtMs > nowMs,
      );
      if (existing) {
        const scope = assignmentOperationScope(existing);
        if (
          !this.operations ||
          (!(await this.operations.hasStarted(`${scope}:persist`)) &&
            !(await this.operations.hasStarted(`${scope}:roles-and-persist`)))
        )
          continue;
        await this.assignTimedRole(existing, { label: "Manual role automation" });
        assignments.push(existing);
        continue;
      }

      const parsedDuration = parseTimedRoleDuration(rule.durationInput, nowMs);
      if (!parsedDuration) {
        continue;
      }

      const assignment: TimedRoleAssignment = {
        guildId: input.guildId,
        userId: input.userId,
        roleId: rule.roleId,
        durationInput: parsedDuration.durationInput,
        expiresAtMs: parsedDuration.expiresAtMs,
        ...(rule.suspendedRoleIds?.length
          ? { suspendedRoleIds: uniqueRoleIds(rule.suspendedRoleIds) }
          : {}),
        ...(input.targetDisplayName != null ? { targetDisplayName: input.targetDisplayName } : {}),
      };

      if (this.operations || (rule.suspendedRoleIds?.length ?? 0) > 0) {
        await this.assignTimedRole(assignment, { label: "Manual role automation" });
      } else {
        await this.store.upsertTimedRole(assignment);
        await this.sendAssignmentDm(assignment, rule.dmMessage ?? null);
        await this.postUpdate(
          assignment.guildId,
          buildTimedRoleUpdateMessage({
            action: "add",
            actor: { label: "Manual role automation" },
            userId: assignment.userId,
            roleId: assignment.roleId,
            durationInput: assignment.durationInput,
            expiresAtMs: assignment.expiresAtMs,
          }),
          "timed-role.assignment",
        );
      }
      assignments.push(assignment);
    }

    return assignments.length > 0 ? assignments : null;
  }

  private async validateAutomationRules(
    resources: GuildResourceScope,
    rules: TimedRoleAutomationRule[],
  ): Promise<void> {
    rules = rules.filter((rule) => rule.enabled !== false);
    const allRoleIds = rules.flatMap((rule) => [rule.roleId, ...(rule.suspendedRoleIds ?? [])]);
    resources.requireRoles(allRoleIds);
    if (!rules.some((rule) => (rule.suspendedRoleIds?.length ?? 0) > 0)) return;
    if (!this.readBotRoleIds) {
      throw new Error("Timed role suspension is not available in this runtime.");
    }

    const rolesById = new Map(resources.roles.map((role) => [role.id, role]));
    const botRoleIds = await this.readBotRoleIds(resources.guildId);
    const highestBotPosition = Math.max(
      -1,
      ...botRoleIds.map((roleId) => rolesById.get(roleId)?.position ?? -1),
    );
    for (const rule of rules) {
      const roleIds = [rule.roleId, ...uniqueRoleIds(rule.suspendedRoleIds ?? [])];
      for (const roleId of roleIds) {
        const role = rolesById.get(roleId)!;
        if (
          role.id === resources.guildId ||
          role.managed === true ||
          role.position >= highestBotPosition
        ) {
          throw new GuildResourceValidationError("role");
        }
      }
      if ((rule.suspendedRoleIds ?? []).includes(rule.roleId)) {
        throw new GuildResourceValidationError("role");
      }
    }
  }

  async getGuildNotificationChannel(guildId: string): Promise<string | null> {
    if (typeof this.notificationStore?.readGuildNotificationChannel !== "function") {
      return null;
    }

    return this.notificationStore.readGuildNotificationChannel(guildId, "timed-role");
  }

  async updateGuildNotificationChannel(
    guildId: string,
    notificationChannelId: string | null,
  ): Promise<void> {
    if (notificationChannelId) {
      await this.guildResources.requireTextChannel(guildId, notificationChannelId);
    }
    if (typeof this.notificationStore?.upsertGuildNotificationChannel !== "function") {
      return;
    }

    await this.notificationStore.upsertGuildNotificationChannel({
      guildId,
      feature: "timed-role",
      notificationChannelId,
    });
  }

  private async postUpdate(
    guildId: string,
    body: ReturnType<typeof buildTimedRoleUpdateMessage>,
    eventId?: "timed-role.assignment" | "timed-role.removal" | "timed-role.expiry",
    assignment?: TimedRoleAssignment,
  ): Promise<void> {
    const baseSender =
      assignment && this.sendChannelMessage && this.deriveMessageNonce
        ? (channelId: string, body: CreateChannelMessageInput) =>
            this.sendChannelMessage!(channelId, {
              ...body,
              nonce: this.deriveMessageNonce!("audit", assignment, channelId),
              enforce_nonce: true,
            })
        : this.sendChannelMessage;
    const sender = baseSender
      ? async (channelId: string, body: CreateChannelMessageInput) => {
          await this.guildResources.requireTextChannel(guildId, channelId);
          return baseSender(channelId, body);
        }
      : undefined;
    await postGuildActivityUpdate(
      this.notificationStore ?? {},
      sender,
      guildId,
      "timed-role",
      body,
      this.auditLogStore,
      eventId,
    );
  }

  private async sendAssignmentDm(
    assignment: TimedRoleAssignment,
    configuredMessage?: string | null,
  ): Promise<void> {
    if (!this.sendUserDm) {
      return;
    }

    const dmMessage = configuredMessage ?? (await this.findAssignmentDmMessage(assignment));
    if (!dmMessage) {
      return;
    }

    try {
      const context = await this.resolveDmContext?.(assignment).catch((error) => {
        console.warn("Failed to resolve timed role assignment DM context", error);
        return {};
      });
      const brandFooterText = await this.resolveFooterText?.(assignment.guildId).catch((error) => {
        console.warn("Failed to resolve timed role assignment DM footer", error);
        return undefined;
      });
      const body = buildTimedRoleAssignmentDm(
        assignment,
        dmMessage,
        context ?? {},
        brandFooterText,
      );
      await this.sendUserDm(assignment.userId, {
        ...body,
        ...(this.deriveMessageNonce
          ? {
              nonce: this.deriveMessageNonce("dm", assignment, assignment.userId),
              enforce_nonce: true,
            }
          : {}),
      });
    } catch (error) {
      if (this.operations) throw error;
      console.warn("Failed to send timed role assignment DM", error);
    }
  }

  private async findAssignmentDmMessage(assignment: TimedRoleAssignment): Promise<string | null> {
    if (!this.store.readTimedRoleConfigRules) {
      return null;
    }

    const ruleSets = await Promise.all([
      this.store.readTimedRoleConfigRules(assignment.guildId, "new-member"),
      this.store.readTimedRoleConfigRules(assignment.guildId, "manual-assignment"),
    ]);
    const rule = ruleSets
      .flat()
      .find((entry) => entry.roleId === assignment.roleId && entry.dmMessage);
    return rule?.dmMessage ?? null;
  }
}

function assignmentOperationScope(assignment: TimedRoleAssignment): string {
  return `timed-role:${assignment.guildId}:${assignment.userId}:${assignment.roleId}`;
}

function hasSuspensionSnapshot(
  assignment: Pick<
    TimedRoleAssignment,
    | "suspendedRoleIds"
    | "pendingSuspensionRoleIds"
    | "removedRoleIds"
    | "restorationStartedAtMs"
    | "targetRoleRemovalCompletedAtMs"
  >,
): boolean {
  return (
    (assignment.suspendedRoleIds?.length ?? 0) > 0 ||
    (assignment.pendingSuspensionRoleIds?.length ?? 0) > 0 ||
    (assignment.removedRoleIds?.length ?? 0) > 0 ||
    assignment.restorationStartedAtMs != null ||
    assignment.targetRoleRemovalCompletedAtMs != null
  );
}

export function buildTimedRoleAssignmentDm(
  assignment: TimedRoleAssignment,
  template: string,
  context: TimedRoleDmContext = {},
  brandFooterText?: string,
): CreateChannelMessageInput {
  const expires = `<t:${Math.floor(assignment.expiresAtMs / 1000)}:R>`;
  const values: Record<string, string> = {
    user: `<@${assignment.userId}>`,
    username: assignment.targetDisplayName ?? "A member",
    role: `<@&${assignment.roleId}>`,
    rolename: context.roleName ?? `<@&${assignment.roleId}>`,
    duration: assignment.durationInput,
    expires,
    expires_at: `<t:${Math.floor(assignment.expiresAtMs / 1000)}:F>`,
    guild: context.guildName ?? "this guild",
  };
  return {
    embeds: [
      {
        title: "Role Assigned",
        color: 0x57f287,
        description: template
          .replace(/\{([a-z_]+)\}/g, (match, key: string) => values[key] ?? match)
          .slice(0, 500),
        fields: [
          { name: "Role", value: `<@&${assignment.roleId}>`, inline: false },
          { name: "Duration", value: assignment.durationInput, inline: false },
          { name: "Expires", value: expires, inline: false },
        ],
        footer: { text: brandFooterText ?? "hafbot.xyz" },
        timestamp: new Date().toISOString(),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

const TIMED_ROLE_DM_PLACEHOLDERS = new Set([
  "user",
  "username",
  "role",
  "rolename",
  "duration",
  "expires",
  "expires_at",
  "guild",
]);

export function validateTimedRoleDmTemplate(
  template: string,
): { valid: true } | { valid: false; error: string } {
  if (template.length > 500) {
    return { valid: false, error: "DM message must be 500 characters or fewer." };
  }
  const unknown = Array.from(template.matchAll(/\{([^{}]+)\}/g))
    .map((match) => match[1] ?? "")
    .filter((name) => !TIMED_ROLE_DM_PLACEHOLDERS.has(name));
  if (unknown.length > 0) {
    return { valid: false, error: `Unknown placeholder: {${unknown[0]}}` };
  }
  return { valid: true };
}

function readTimedRoleAutomationRules(config: {
  roles?: TimedRoleAutomationRule[];
  roleId?: string | null;
  durationInput?: string | null;
}): TimedRoleAutomationRule[] {
  if (Array.isArray(config.roles)) {
    return config.roles.filter((rule) => rule.enabled !== false);
  }
  return config.roleId && config.durationInput
    ? [{ roleId: config.roleId, durationInput: config.durationInput }]
    : [];
}
