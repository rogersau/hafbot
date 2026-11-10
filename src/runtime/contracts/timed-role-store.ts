import type {
  ManualAssignmentTimedRoleConfig,
  NewMemberTimedRoleConfig,
  TimedRoleAutomationRule,
  TimedRoleAssignment,
} from "../../types";

export type TimedRoleConfigType = "new-member" | "manual-assignment";

export interface TimedRoleStore {
  listTimedRoles(): Promise<TimedRoleAssignment[]>;
  listTimedRolesByGuild(guildId: string): Promise<TimedRoleAssignment[]>;
  upsertTimedRole(body: TimedRoleAssignment): Promise<void>;
  updateTimedRoleSuspension(body: {
    guildId: string;
    userId: string;
    roleId: string;
    pendingSuspensionRoleIds: string[];
    removedRoleIds: string[];
    pendingRestorationRoleIds: string[];
  }): Promise<void>;
  updateTimedRoleRestoration(body: {
    guildId: string;
    userId: string;
    roleId: string;
    pendingRestorationRoleIds: string[];
    restorationStartedAtMs: number;
    targetRoleRemovalCompletedAtMs: number | null;
  }): Promise<void>;
  deleteTimedRole(body: { guildId: string; userId: string; roleId: string }): Promise<void>;
  listExpiredTimedRoles(nowMs: number): Promise<TimedRoleAssignment[]>;
  readTimedRoleConfigRules?(
    guildId: string,
    configType: TimedRoleConfigType,
  ): Promise<TimedRoleAutomationRule[]>;
  upsertTimedRoleConfigRules?(
    guildId: string,
    configType: TimedRoleConfigType,
    rules: TimedRoleAutomationRule[],
  ): Promise<void>;
  readNewMemberTimedRoleConfig?(guildId: string): Promise<NewMemberTimedRoleConfig>;
  upsertNewMemberTimedRoleConfig?(body: NewMemberTimedRoleConfig): Promise<void>;
  readManualAssignmentTimedRoleConfig?(guildId: string): Promise<ManualAssignmentTimedRoleConfig>;
  upsertManualAssignmentTimedRoleConfig?(body: ManualAssignmentTimedRoleConfig): Promise<void>;
}
