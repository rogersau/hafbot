import type {
  TicketInstance,
  TicketPanelConfig,
  TicketParticipant,
  TicketParticipantEvent,
  TicketTemplateReply,
} from "../../types";

export interface ClosedTicketInstancesPage {
  tickets: TicketInstance[];
  total: number;
  nextCursor: number | null;
}

export interface StaffMessageDeliveryIdentity {
  guildId: string;
  staffThreadId: string;
  staffMessageId: string;
}

export interface StaffMessageDeliveryClaim extends StaffMessageDeliveryIdentity {
  ticketChannelId: string;
  staffUserId: string;
  staffDisplayName: string;
  content: string;
  createdAtMs: number;
}

export interface TicketClaimDeliveryIdentity {
  guildId: string;
  channelId: string;
  claimedByUserId: string;
  claimedAtMs: number;
  phase: "announcement" | "audit";
}

export interface TicketStore {
  reserveNextTicketNumber(guildId: string): Promise<number>;
  readTicketPanelConfig(guildId: string): Promise<TicketPanelConfig | null>;
  readTicketPanelConfigById(guildId: string, panelId: string): Promise<TicketPanelConfig | null>;
  listTicketPanelConfigs(guildId: string): Promise<TicketPanelConfig[]>;
  upsertTicketPanelConfig(panel: TicketPanelConfig): Promise<void>;
  countOpenTicketsByUser(guildId: string, userId: string): Promise<number>;
  createTicketInstance(instance: TicketInstance): Promise<void>;
  deleteTicketInstance(body: { guildId: string; channelId: string }): Promise<void>;
  readOpenTicketByChannel(guildId: string, channelId: string): Promise<TicketInstance | null>;
  readTicketParticipant(
    guildId: string,
    ticketChannelId: string,
    userId: string,
  ): Promise<TicketParticipant | null>;
  addTicketParticipant(
    body: Omit<TicketParticipant, "addedEventId"> & { ticketTypeId: string },
  ): Promise<{ created: boolean; eventId: string }>;
  removeTicketParticipant(body: {
    guildId: string;
    ticketChannelId: string;
    ticketTypeId: string;
    userId: string;
    removedByUserId: string;
    removedAtMs: number;
  }): Promise<{ removed: boolean; eventId: string | null }>;
  listTicketParticipants(guildId: string, ticketChannelId: string): Promise<TicketParticipant[]>;
  listTicketParticipantEvents(
    guildId: string,
    ticketChannelId: string,
  ): Promise<TicketParticipantEvent[]>;
  readLatestTicketParticipantEvent(body: {
    guildId: string;
    ticketChannelId: string;
    targetUserId: string;
    action: TicketParticipantEvent["action"];
  }): Promise<TicketParticipantEvent | null>;
  claimTicketParticipantNotification(eventId: string, claimedAtMs: number): Promise<boolean>;
  completeTicketParticipantNotification(eventId: string, claimedAtMs: number): Promise<void>;
  releaseTicketParticipantNotification(eventId: string, claimedAtMs: number): Promise<void>;
  updateTicketClaim(body: {
    guildId: string;
    channelId: string;
    claimedByUserId: string | null;
    claimedAtMs: number | null;
  }): Promise<void>;
  updateTicketOpeningMessageId(body: {
    guildId: string;
    channelId: string;
    openingMessageId: string;
  }): Promise<void>;
  claimTicketClaimDelivery(
    body: TicketClaimDeliveryIdentity & { leaseUntilMs: number; nowMs: number },
  ): Promise<boolean>;
  completeTicketClaimDelivery(
    body: TicketClaimDeliveryIdentity & { leaseUntilMs: number },
  ): Promise<void>;
  releaseTicketClaimDelivery(
    body: TicketClaimDeliveryIdentity & { leaseUntilMs: number },
  ): Promise<void>;
  listClosedTicketInstances(body: {
    guildId: string;
    panelId?: string | null;
    limit: number;
    beforeOpenedAtMs: number | null;
  }): Promise<ClosedTicketInstancesPage>;
  listMemberTicketHistory(body: {
    guildId: string;
    openerUserId: string;
    excludeChannelId?: string | null;
    limit: number;
    beforeOpenedAtMs: number | null;
  }): Promise<ClosedTicketInstancesPage>;
  countOpenTicketsForPanel(guildId: string, panelId: string): Promise<number>;
  deleteTicketPanelConfig(guildId: string, panelId: string): Promise<void>;
  closeTicketInstance(body: {
    guildId: string;
    channelId: string;
    closedByUserId: string;
    closedAtMs: number;
    transcriptMessageId: string | null;
  }): Promise<void>;
  readOpenTicketByStaffThread(
    guildId: string,
    staffThreadId: string,
  ): Promise<TicketInstance | null>;
  updateTicketInstanceStaffThreadId(body: {
    guildId: string;
    channelId: string;
    staffThreadId: string | null;
  }): Promise<void>;
  recordStaffMessageMapping(body: {
    guildId: string;
    ticketChannelId: string;
    staffThreadId: string;
    staffMessageId: string;
    botMessageId: string;
    staffUserId: string;
    staffDisplayName: string;
    content: string;
    createdAtMs: number;
  }): Promise<void>;
  claimStaffMessageDelivery(body: StaffMessageDeliveryClaim): Promise<boolean>;
  completeStaffMessageDelivery(
    body: StaffMessageDeliveryIdentity & { botMessageId: string; claimedAtMs: number },
  ): Promise<void>;
  releaseStaffMessageDelivery(
    body: StaffMessageDeliveryIdentity & { claimedAtMs: number },
  ): Promise<void>;
  readStaffMessageMapping(body: {
    guildId: string;
    ticketChannelId: string;
    botMessageId: string;
  }): Promise<{ staffUserId: string; staffDisplayName: string } | null>;
  readStaffMessageMappingByStaffMessage(body: {
    guildId: string;
    staffThreadId: string;
    staffMessageId: string;
  }): Promise<{
    ticketChannelId: string;
    botMessageId: string;
    staffUserId: string;
    staffDisplayName: string;
    content: string;
  } | null>;
  updateStaffMessageMapping(body: {
    guildId: string;
    staffThreadId: string;
    staffMessageId: string;
    staffDisplayName: string;
    content: string;
  }): Promise<void>;
  deleteStaffMessageMapping(body: {
    guildId: string;
    staffThreadId: string;
    staffMessageId: string;
  }): Promise<void>;
  cleanupStaffMessages(body: { guildId: string; ticketChannelId: string }): Promise<void>;
  claimTicketTemplateReply(reply: TicketTemplateReply): Promise<boolean>;
  completeTicketTemplateReply(body: { interactionId: string; botMessageId: string }): Promise<void>;
  releaseTicketTemplateReply(interactionId: string): Promise<void>;
  listTicketTemplateReplies(
    guildId: string,
    ticketChannelId: string,
  ): Promise<TicketTemplateReply[]>;
}
