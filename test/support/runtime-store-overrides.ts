import type {
  BlocklistConfig,
  ChannelFilterMode,
  TicketInstance,
  TicketPanelConfig,
  TimedRoleAssignment,
} from "../../src/types";
import type { AppConfigMutation } from "../../src/runtime/admin-types";
import type { GatewaySnapshot } from "../../src/runtime/contracts";

/** Flat overrides used only by the runtime-app test fixture. */
export interface RuntimeStore {
  readConfig(): Promise<BlocklistConfig>;
  upsertAppConfig(body: AppConfigMutation): Promise<void>;
  applyGuildEmojiMutation(body: {
    guildId: string;
    emoji: string;
    action: "add" | "remove";
  }): Promise<BlocklistConfig>;
  upsertGuildChannelFilter?(body: {
    guildId: string;
    channelMode: ChannelFilterMode;
    channelIds: string[];
  }): Promise<BlocklistConfig>;
  reserveNextTicketNumber(guildId: string): Promise<number>;
  readTicketPanelConfig(guildId: string): Promise<TicketPanelConfig | null>;
  upsertTicketPanelConfig(panel: TicketPanelConfig): Promise<void>;
  countOpenTicketsByUser(guildId: string, userId: string): Promise<number>;
  createTicketInstance(instance: TicketInstance): Promise<void>;
  deleteTicketInstance(body: { guildId: string; channelId: string }): Promise<void>;
  readOpenTicketByChannel(guildId: string, channelId: string): Promise<TicketInstance | null>;
  updateTicketClaim(body: {
    guildId: string;
    channelId: string;
    claimedByUserId: string | null;
    claimedAtMs: number | null;
  }): Promise<void>;
  listClosedTicketInstances(body: {
    guildId: string;
    panelId?: string | null;
    limit: number;
    beforeOpenedAtMs: number | null;
  }): Promise<{ tickets: TicketInstance[]; total: number; nextCursor: number | null }>;
  closeTicketInstance(body: {
    guildId: string;
    channelId: string;
    closedByUserId: string;
    closedAtMs: number;
    transcriptMessageId: string | null;
    staffThreadId?: string | null;
  }): Promise<void>;
  listTimedRoles(): Promise<TimedRoleAssignment[]>;
  listTimedRolesByGuild(guildId: string): Promise<TimedRoleAssignment[]>;
  upsertTimedRole(body: TimedRoleAssignment): Promise<void>;
  deleteTimedRole(body: { guildId: string; userId: string; roleId: string }): Promise<void>;
  listExpiredTimedRoles(nowMs: number): Promise<TimedRoleAssignment[]>;
  readGatewaySnapshot(): Promise<GatewaySnapshot>;
  writeGatewaySnapshot(snapshot: GatewaySnapshot): Promise<void>;
}
