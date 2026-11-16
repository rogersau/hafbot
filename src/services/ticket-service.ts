import type { BlocklistStore, TicketStore } from "../runtime/contracts";
import type {
  TicketPanelConfig,
  TicketTypeConfig,
  TicketInstance,
  TicketAnswer,
  TicketLinkPlatform,
} from "../types";

export interface CreateTicketChannelConfig {
  guildId: string;
  name: string;
  parentId: string;
  botUserId: string;
  openerUserId: string;
  supportRoleId: string;
  anonymousEnabled?: boolean;
}

export interface TicketServiceOptions {
  guildId: string;
  openerUserId: string;
  openerRoleIds?: string[];
  panel: TicketPanelConfig;
  ticketType: TicketTypeConfig;
  answers: TicketAnswer[];
  platformLinkConfigs?: Partial<
    Record<
      TicketLinkPlatform,
      {
        linkedRoleId: string | null;
        panelButtonLabel: string;
        panelButtonStyle: string;
      } | null
    >
  >;
}

export class TicketService {
  constructor(
    private readonly blocklistStore: BlocklistStore,
    private readonly ticketStore: TicketStore,
    _botToken: string,
    private readonly createChannel?: (config: CreateTicketChannelConfig) => Promise<{ id: string }>,
    private readonly deleteChannel?: (channelId: string) => Promise<void>,
    private readonly createStaffThread?: (
      channelId: string,
      name: string,
    ) => Promise<{ id: string }>,
    private readonly deleteStaffThread?: (threadId: string) => Promise<void>,
  ) {}

  async openTicket(options: TicketServiceOptions): Promise<TicketInstance> {
    if (!this.createChannel) {
      throw new Error("createChannel handler not configured");
    }

    const { openTicket } = await import("./tickets/open-ticket");
    return openTicket(
      {
        readConfig: () => this.blocklistStore.readConfig(),
        reserveNextTicketNumber: (guildId: string) =>
          this.ticketStore.reserveNextTicketNumber(guildId),
        countOpenTicketsByUser: (guildId: string, userId: string) =>
          this.ticketStore.countOpenTicketsByUser(guildId, userId),
        createTicketInstance: (instance: TicketInstance) =>
          this.ticketStore.createTicketInstance(instance),
        deleteTicketInstance: (body: { guildId: string; channelId: string }) =>
          this.ticketStore.deleteTicketInstance(body),
        updateTicketOpeningMessageId: (body) => this.ticketStore.updateTicketOpeningMessageId(body),
        listMemberTicketHistory: (body) => this.ticketStore.listMemberTicketHistory(body),
      },
      {
        createChannel: this.createChannel,
        deleteChannel: this.deleteChannel ?? (async () => {}),
        createStaffThread: this.createStaffThread,
        deleteStaffThread: this.deleteStaffThread ?? this.deleteChannel,
        createOpeningMessage: async () => {},
        createAutoReplyMessage: async () => {},
      },
      options,
    );
  }

  async closeTicket(options: { guildId: string; channelId: string }): Promise<void> {
    if (this.deleteChannel) {
      await this.deleteChannel(options.channelId);
    }

    await this.ticketStore.closeTicketInstance({
      guildId: options.guildId,
      channelId: options.channelId,
      closedByUserId: "system",
      closedAtMs: Date.now(),
      transcriptMessageId: null,
    });
  }
}
