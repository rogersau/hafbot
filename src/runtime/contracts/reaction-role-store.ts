import type { ReactionRolePanel } from "../../reaction-roles";

export interface ReactionRoleWriteLease {
  token: string;
  nowMs: number;
}

export interface ReactionRoleStore {
  readPanel(guildId: string, panelId?: string): Promise<ReactionRolePanel | null>;
  listPanels(guildId: string): Promise<ReactionRolePanel[]>;
  readPanelByMessage(
    guildId: string,
    channelId: string,
    messageId: string,
  ): Promise<ReactionRolePanel | null>;
  savePanel(panel: ReactionRolePanel, lease: ReactionRoleWriteLease): Promise<boolean>;
  deletePanel(guildId: string, lease: ReactionRoleWriteLease, panelId?: string): Promise<boolean>;
  readRestrictedRoleIds(
    guildId: string,
    options?: { excludeReputationRewards?: boolean },
  ): Promise<Set<string>>;
  isRoleSuspended(guildId: string, userId: string, roleId: string): Promise<boolean>;
  claimLease(guildId: string, token: string, nowMs: number): Promise<boolean>;
  renewLease(guildId: string, token: string, nowMs: number): Promise<boolean>;
  releaseLease(guildId: string, token: string): Promise<void>;
}
