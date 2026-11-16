import { z } from "zod";

// These fields map to the existing Timed Role Assignment columns. The state name
// is derived from the current assignment.
const progressSchema = z.object({
  suspendedRoleIds: z.array(z.string()),
  pendingSuspensionRoleIds: z.array(z.string()),
  removedRoleIds: z.array(z.string()),
  pendingRestorationRoleIds: z.array(z.string()),
});
const assignedSchema = progressSchema.extend({
  restorationStartedAtMs: z.null(),
  targetRoleRemovalCompletedAtMs: z.null(),
});
const restoringSchema = progressSchema.extend({
  restorationStartedAtMs: z.number().finite(),
  targetRoleRemovalCompletedAtMs: z.number().finite(),
});

export const timedRoleWorkflowSchema = z.discriminatedUnion("kind", [
  assignedSchema.extend({
    kind: z.literal("suspending"),
    pendingSuspensionRoleIds: z.array(z.string()).min(1),
  }),
  assignedSchema.extend({
    kind: z.literal("active"),
    pendingSuspensionRoleIds: z.tuple([]),
  }),
  assignedSchema.extend({
    kind: z.literal("compensating"),
    pendingSuspensionRoleIds: z.tuple([]),
    targetRoleRemovalRequired: z.boolean(),
  }),
  progressSchema.extend({
    kind: z.literal("removing-target"),
    restorationStartedAtMs: z.number().finite(),
    targetRoleRemovalCompletedAtMs: z.null(),
  }),
  restoringSchema.extend({
    kind: z.literal("restoring-roles"),
    pendingRestorationRoleIds: z.array(z.string()).min(1),
  }),
  restoringSchema.extend({
    kind: z.literal("ready-to-delete"),
    pendingSuspensionRoleIds: z.tuple([]),
    pendingRestorationRoleIds: z.tuple([]),
  }),
  z.object({ kind: z.literal("completed") }),
]);

export type TimedRoleWorkflow = z.infer<typeof timedRoleWorkflowSchema>;
type Progress = z.infer<typeof progressSchema>;
type PersistedWorkflow = Exclude<TimedRoleWorkflow, { kind: "completed" | "compensating" }>;

const storedProgressSchema = progressSchema.partial().extend({
  restorationStartedAtMs: z.number().finite().nullish(),
  targetRoleRemovalCompletedAtMs: z.number().finite().nullish(),
});

export function readTimedRoleWorkflow(stored: unknown): PersistedWorkflow {
  const value = storedProgressSchema.parse(stored);
  const progress = {
    suspendedRoleIds: uniqueRoleIds(value.suspendedRoleIds ?? []),
    pendingSuspensionRoleIds: uniqueRoleIds(value.pendingSuspensionRoleIds ?? []),
    removedRoleIds: uniqueRoleIds(value.removedRoleIds ?? []),
    // An explicitly empty list means restoration already completed these roles.
    pendingRestorationRoleIds: uniqueRoleIds(
      value.pendingRestorationRoleIds ?? value.removedRoleIds ?? [],
    ),
    restorationStartedAtMs: value.restorationStartedAtMs ?? null,
    targetRoleRemovalCompletedAtMs: value.targetRoleRemovalCompletedAtMs ?? null,
  };
  if (progress.restorationStartedAtMs != null) {
    progress.pendingRestorationRoleIds = uniqueRoleIds([
      ...progress.pendingRestorationRoleIds,
      ...progress.pendingSuspensionRoleIds,
    ]);
  }
  const kind =
    progress.restorationStartedAtMs == null
      ? progress.pendingSuspensionRoleIds.length > 0
        ? "suspending"
        : "active"
      : progress.targetRoleRemovalCompletedAtMs == null
        ? "removing-target"
        : progress.pendingRestorationRoleIds.length + progress.pendingSuspensionRoleIds.length > 0
          ? "restoring-roles"
          : "ready-to-delete";
  const state = timedRoleWorkflowSchema.parse({ ...progress, kind });
  if (state.kind === "completed" || state.kind === "compensating") {
    throw new Error("Invalid persisted timed role workflow.");
  }
  return state;
}

export type TimedRoleWorkflowEvent =
  | { type: "suspension-confirmed"; roleId: string }
  | {
      type: "compensation-requested";
      targetRoleRemovalRequired: boolean;
      uncertainRemovalRoleId?: string;
    }
  | { type: "compensation-role-restored"; roleId: string }
  | { type: "compensation-target-removed" }
  | { type: "compensation-finished"; snapshotPersisted: boolean }
  | { type: "restoration-requested"; nowMs: number }
  | { type: "target-removal-confirmed"; nowMs: number }
  | { type: "restoration-attempted"; remainingRoleIds: string[] };

export type TimedRoleWorkflowEffect =
  | { type: "persist-suspension"; progress: Omit<Progress, "suspendedRoleIds"> }
  | {
      type: "persist-restoration";
      progress: {
        pendingRestorationRoleIds: string[];
        restorationStartedAtMs: number;
        targetRoleRemovalCompletedAtMs: number | null;
      };
    }
  | { type: "delete-assignment" };

export interface TimedRoleWorkflowTransition {
  state: TimedRoleWorkflow;
  effects: TimedRoleWorkflowEffect[];
}

/** Decide durable progress only. The service owns Discord calls and executes effects in order. */
export function transitionTimedRoleWorkflow(
  state: TimedRoleWorkflow,
  event: TimedRoleWorkflowEvent,
): TimedRoleWorkflowTransition {
  switch (event.type) {
    case "suspension-confirmed": {
      if (state.kind !== "suspending" || !state.pendingSuspensionRoleIds.includes(event.roleId)) {
        break;
      }
      const pendingSuspensionRoleIds = state.pendingSuspensionRoleIds.filter(
        (id) => id !== event.roleId,
      );
      const next = {
        ...state,
        kind: pendingSuspensionRoleIds.length > 0 ? "suspending" : "active",
        pendingSuspensionRoleIds,
        removedRoleIds: uniqueRoleIds([...state.removedRoleIds, event.roleId]),
        pendingRestorationRoleIds: uniqueRoleIds([
          ...state.pendingRestorationRoleIds,
          event.roleId,
        ]),
      };
      return {
        state: timedRoleWorkflowSchema.parse(next),
        effects: [{ type: "persist-suspension", progress: suspensionProgress(next) }],
      };
    }
    case "compensation-requested": {
      if (state.kind !== "suspending" && state.kind !== "active") break;
      if (
        event.uncertainRemovalRoleId !== undefined &&
        !state.pendingSuspensionRoleIds.some((roleId) => roleId === event.uncertainRemovalRoleId)
      )
        break;
      const removedRoleIds = uniqueRoleIds([
        ...state.removedRoleIds,
        ...(event.uncertainRemovalRoleId === undefined ? [] : [event.uncertainRemovalRoleId]),
      ]);
      return {
        state: timedRoleWorkflowSchema.parse({
          ...state,
          kind: "compensating",
          pendingSuspensionRoleIds: [],
          removedRoleIds,
          pendingRestorationRoleIds: removedRoleIds,
          targetRoleRemovalRequired: event.targetRoleRemovalRequired,
        }),
        effects: [],
      };
    }
    case "compensation-role-restored": {
      if (
        state.kind !== "compensating" ||
        !state.pendingRestorationRoleIds.includes(event.roleId)
      ) {
        break;
      }
      return {
        state: {
          ...state,
          pendingRestorationRoleIds: state.pendingRestorationRoleIds.filter(
            (id) => id !== event.roleId,
          ),
        },
        effects: [],
      };
    }
    case "compensation-target-removed": {
      if (state.kind !== "compensating") break;
      return { state: { ...state, targetRoleRemovalRequired: false }, effects: [] };
    }
    case "compensation-finished": {
      if (
        state.kind !== "compensating" ||
        state.pendingRestorationRoleIds.length > 0 ||
        state.targetRoleRemovalRequired
      ) {
        break;
      }
      return {
        state: { kind: "completed" },
        effects: event.snapshotPersisted ? [{ type: "delete-assignment" }] : [],
      };
    }
    case "restoration-requested": {
      if (state.kind === "completed" || state.kind === "compensating") break;
      // A pending DELETE may have succeeded before its checkpoint failed. Include
      // that intent in recovery rather than forgetting a possibly removed role.
      const pendingRestorationRoleIds = uniqueRoleIds([
        ...state.pendingRestorationRoleIds,
        ...state.pendingSuspensionRoleIds,
      ]);
      const next = timedRoleWorkflowSchema.parse({
        ...state,
        kind:
          state.targetRoleRemovalCompletedAtMs == null
            ? "removing-target"
            : pendingRestorationRoleIds.length > 0
              ? "restoring-roles"
              : "ready-to-delete",
        restorationStartedAtMs: state.restorationStartedAtMs ?? event.nowMs,
        removedRoleIds: uniqueRoleIds([...state.removedRoleIds, ...state.pendingSuspensionRoleIds]),
        pendingSuspensionRoleIds: [],
        pendingRestorationRoleIds,
      });
      if (next.kind === "completed" || next.restorationStartedAtMs == null) break;
      const effects: TimedRoleWorkflowEffect[] = [];
      if (state.restorationStartedAtMs == null) {
        effects.push({ type: "persist-restoration", progress: restorationProgress(next) });
      }
      if (state.pendingSuspensionRoleIds.length > 0) {
        effects.push({ type: "persist-suspension", progress: suspensionProgress(next) });
      }
      return { state: next, effects };
    }
    case "target-removal-confirmed": {
      if (state.kind !== "removing-target" || state.pendingSuspensionRoleIds.length > 0) break;
      const next = {
        ...state,
        kind: state.pendingRestorationRoleIds.length > 0 ? "restoring-roles" : "ready-to-delete",
        targetRoleRemovalCompletedAtMs: event.nowMs,
      };
      return {
        state: timedRoleWorkflowSchema.parse(next),
        effects: [{ type: "persist-restoration", progress: restorationProgress(next) }],
      };
    }
    case "restoration-attempted": {
      if (state.kind !== "restoring-roles" && state.kind !== "ready-to-delete") break;
      if (state.pendingSuspensionRoleIds.length > 0) break;
      const remaining = uniqueRoleIds(event.remainingRoleIds);
      const pending = new Set(state.pendingRestorationRoleIds);
      if (remaining.some((id) => !pending.has(id))) break;
      if (remaining.length === 0) {
        return { state: { kind: "completed" }, effects: [{ type: "delete-assignment" }] };
      }
      const next = {
        ...state,
        kind: "restoring-roles" as const,
        pendingRestorationRoleIds: remaining,
      };
      return {
        state: next,
        effects: sameRoleIds(remaining, state.pendingRestorationRoleIds)
          ? []
          : [{ type: "persist-restoration", progress: restorationProgress(next) }],
      };
    }
    default: {
      const unexpected: never = event;
      throw new Error(`Unknown timed role workflow event: ${unexpected}`);
    }
  }
  throw new Error(`Cannot apply ${event.type} while timed role is ${state.kind}.`);
}

function restorationProgress(state: {
  pendingRestorationRoleIds: string[];
  restorationStartedAtMs: number;
  targetRoleRemovalCompletedAtMs: number | null;
}) {
  return {
    pendingRestorationRoleIds: state.pendingRestorationRoleIds,
    restorationStartedAtMs: state.restorationStartedAtMs,
    targetRoleRemovalCompletedAtMs: state.targetRoleRemovalCompletedAtMs,
  };
}

function suspensionProgress(state: Progress) {
  return {
    pendingSuspensionRoleIds: state.pendingSuspensionRoleIds,
    removedRoleIds: state.removedRoleIds,
    pendingRestorationRoleIds: state.pendingRestorationRoleIds,
  };
}

export function uniqueRoleIds(roleIds: readonly string[]): string[] {
  return [...new Set(roleIds.map((roleId) => roleId.trim()).filter(Boolean))];
}

function sameRoleIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((roleId, index) => roleId === right[index]);
}
