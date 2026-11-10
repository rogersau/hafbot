export interface GuildRbacStore {
  readManageServerAdminEnabled(guildId: string): Promise<boolean>;
  setManageServerAdminEnabled(guildId: string, enabled: boolean): Promise<void>;
  readGuildAdminRoleId(guildId: string): Promise<string | null>;
  listGuildAdminRoleAssignments(): Promise<Array<{ guildId: string; roleId: string }>>;
  upsertGuildAdminRoleId(guildId: string, roleId: string | null): Promise<void>;
}
