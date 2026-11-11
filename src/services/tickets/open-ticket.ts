import {
  transitionTicketOpen,
  ticketOpenNeedsRecordRollback,
  type TicketOpenWorkflow,
} from "./open-workflow";
import {
  buildTicketChannelName,
  renderTicketAutoReply,
  selectMatchingResponseRules,
} from "../../tickets";
import { allowUserMentions, formatUserMention } from "../../discord";
import type { DiscordAllowedMentions } from "../../discord";
import type { BlocklistStore, TicketStore } from "../../runtime/contracts";
import type {
  TicketInstance,
  TicketLinkPlatform,
  TicketResponseRule,
  TicketTypeConfig,
} from "../../types";
import { buildPlatformLinkActionRow } from "../../runtime/platform-link-buttons";
import type { CreateTicketChannelConfig, TicketServiceOptions } from "../ticket-service";

const DEFAULT_TICKET_LIMIT_REJECTION_MESSAGE =
  "You already have the maximum number of open tickets. Please close an existing ticket before opening another.";

export class TicketCreationLimitError extends Error {
  constructor(public readonly rejectionMessage: string) {
    super(rejectionMessage);
    this.name = "TicketCreationLimitError";
  }
}

export class TicketPersistenceError extends Error {
  constructor(public readonly cause: unknown) {
    super(cause instanceof Error ? cause.message : "Ticket persistence failed.");
    this.name = "TicketPersistenceError";
  }
}

export type TicketOpenRollbackStep = "ticket-record" | "staff-thread" | "ticket-channel";

export class TicketOpenRollbackError extends Error {
  constructor(
    public readonly cause: unknown,
    public readonly failedSteps: TicketOpenRollbackStep[],
    public readonly channelId: string,
    public readonly staffThreadId: string | null,
  ) {
    super("Ticket opening failed and automatic cleanup was incomplete.");
    this.name = "TicketOpenRollbackError";
  }
}

export async function openTicket(
  store: Pick<
    TicketStore,
    | "reserveNextTicketNumber"
    | "countOpenTicketsByUser"
    | "createTicketInstance"
    | "deleteTicketInstance"
  > &
    Pick<BlocklistStore, "readConfig"> &
    Partial<Pick<TicketStore, "listMemberTicketHistory" | "updateTicketOpeningMessageId">>,
  adapters: {
    createChannel: (config: CreateTicketChannelConfig) => Promise<{ id: string }>;
    deleteChannel: (channelId: string) => Promise<void>;
    createStaffThread?: (channelId: string, name: string) => Promise<{ id: string }>;
    deleteStaffThread?: (threadId: string) => Promise<void>;
    createOpeningMessage: (
      channelId: string,
      ticketNumber: number,
      body: {
        content: string;
        allowed_mentions: DiscordAllowedMentions;
        components: unknown[];
      },
    ) => Promise<{ id: string } | void>;
    createAutoReplyMessage: (
      channelId: string,
      body:
        | string
        | { content: string; allowed_mentions: DiscordAllowedMentions; components: unknown[] },
    ) => Promise<void>;
    recordLinkReminder?: (input: {
      channelId: string;
      ticketType: TicketTypeConfig;
      rule: TicketResponseRule;
      platform: TicketLinkPlatform;
    }) => Promise<void>;
    createTicketHistoryPrompt?: (
      staffThreadId: string,
      count: number,
      ticketChannelId: string,
    ) => Promise<void>;
    createAnonymousSupportHelper?: (staffThreadId: string) => Promise<void>;
  },
  options: TicketServiceOptions,
): Promise<TicketInstance> {
  const config = await store.readConfig();
  const anonymousSupportEnabled = options.ticketType.anonymousSupportEnabled ?? false;
  const staffDiscussionThreadEnabled = options.ticketType.staffDiscussionThreadEnabled ?? false;
  const staffThreadEnabled = anonymousSupportEnabled || staffDiscussionThreadEnabled;
  if (options.panel.ticketCreationLimit !== null && !options.ticketType.limitExclusion) {
    const openTicketCount = await store.countOpenTicketsByUser(
      options.guildId,
      options.openerUserId,
    );
    if (openTicketCount >= options.panel.ticketCreationLimit) {
      throw new TicketCreationLimitError(
        options.panel.ticketLimitRejectionMessage ?? DEFAULT_TICKET_LIMIT_REJECTION_MESSAGE,
      );
    }
  }

  const ticketNumber = await store.reserveNextTicketNumber(options.guildId);
  const channel = await adapters.createChannel({
    guildId: options.guildId,
    name: buildTicketChannelName(options.ticketType.channelNamePrefix, ticketNumber),
    parentId: options.panel.categoryChannelId,
    botUserId: config.botUserId,
    openerUserId: options.openerUserId,
    supportRoleId: options.ticketType.supportRoleId,
    anonymousEnabled: staffThreadEnabled,
  });

  const instance: TicketInstance = {
    guildId: options.guildId,
    channelId: channel.id,
    panelId: options.panel.panelId ?? "main",
    ticketTypeId: options.ticketType.id,
    ticketTypeLabel: options.ticketType.label,
    openerUserId: options.openerUserId,
    supportRoleId: options.ticketType.supportRoleId,
    status: "open",
    answers: options.answers,
    openedAtMs: Date.now(),
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
    claimedByUserId: null,
    claimedAtMs: null,
  };

  let workflow: TicketOpenWorkflow = { kind: "resources-created", staffThreadId: null };
  try {
    if (staffThreadEnabled && adapters.createStaffThread) {
      const thread = await adapters.createStaffThread(channel.id, "staff-discussion");
      instance.staffThreadId = thread.id;
      workflow = transitionTicketOpen(workflow, {
        type: "staff-thread-created",
        threadId: thread.id,
      });
    }

    try {
      await store.createTicketInstance(instance);
    } catch (error) {
      throw new TicketPersistenceError(error);
    }
    workflow = transitionTicketOpen(workflow, { type: "record-created" });
    const staffThreadId = workflow.staffThreadId;
    const openingMessage = await adapters.createOpeningMessage(channel.id, ticketNumber, {
      content: buildOpeningMessageContent(
        ticketNumber,
        options.openerUserId,
        options.ticketType.mentionSupportRole === true ? options.ticketType.supportRoleId : null,
      ),
      allowed_mentions:
        options.ticketType.mentionSupportRole === true
          ? { parse: [], users: [options.openerUserId], roles: [options.ticketType.supportRoleId] }
          : allowUserMentions([options.openerUserId]),
      components: [],
    });
    if (openingMessage) {
      if (!store.updateTicketOpeningMessageId)
        throw new Error("Ticket opening message persistence is unavailable.");
      await store.updateTicketOpeningMessageId({
        guildId: instance.guildId,
        channelId: instance.channelId,
        openingMessageId: openingMessage.id,
      });
      instance.openingMessageId = openingMessage.id;
    }

    if (staffThreadId && anonymousSupportEnabled && adapters.createAnonymousSupportHelper) {
      try {
        await adapters.createAnonymousSupportHelper(staffThreadId);
      } catch (error) {
        console.error("Failed to create Anonymous Support helper", error);
      }
    }

    if (
      options.ticketType.ticketHistoryPromptVisibility === "staff-thread" &&
      staffThreadId &&
      store.listMemberTicketHistory &&
      adapters.createTicketHistoryPrompt
    ) {
      try {
        const history = await store.listMemberTicketHistory({
          guildId: options.guildId,
          openerUserId: options.openerUserId,
          excludeChannelId: channel.id,
          limit: 1,
          beforeOpenedAtMs: null,
        });
        if (history.total > 0) {
          await adapters.createTicketHistoryPrompt(staffThreadId, history.total, channel.id);
        }
      } catch (error) {
        console.error("Failed to create Ticket History Prompt", error);
      }
    }

    const matchingResponseRules = selectMatchingResponseRules(
      options.ticketType.responseRules,
      options.openerRoleIds ?? [],
      {
        defaultTicketLinkPlatform: options.ticketType.defaultTicketLinkPlatform ?? null,
        platformLinkedRoleIds: {
          steam: options.platformLinkConfigs?.steam?.linkedRoleId ?? null,
          xbox: options.platformLinkConfigs?.xbox?.linkedRoleId ?? null,
          playstation: options.platformLinkConfigs?.playstation?.linkedRoleId ?? null,
        },
      },
    );
    const responseOpenedAtMs = Date.now();
    for (const rule of matchingResponseRules) {
      const rendered = renderTicketAutoReply(
        rule.message,
        options.answers,
        options.openerUserId,
        responseOpenedAtMs,
      );
      try {
        const linkPlatform = resolveResponseRuleLinkPlatform(rule, options.ticketType);
        const linkConfig = linkPlatform ? options.platformLinkConfigs?.[linkPlatform] : null;
        if (linkPlatform && linkConfig) {
          await adapters.createAutoReplyMessage(channel.id, {
            content: rendered,
            allowed_mentions: { parse: [] },
            components: [buildPlatformLinkActionRow(linkPlatform, linkConfig)],
          });
          await adapters.recordLinkReminder?.({
            channelId: channel.id,
            ticketType: options.ticketType,
            rule,
            platform: linkPlatform,
          });
        } else {
          await adapters.createAutoReplyMessage(channel.id, rendered);
        }
      } catch (error) {
        console.error("Failed to send ticket response", error);
      }
    }

    workflow = transitionTicketOpen(workflow, { type: "ready" });
    return instance;
  } catch (error) {
    const staffThreadId = workflow.staffThreadId;
    const failedSteps: TicketOpenRollbackStep[] = [];
    if (ticketOpenNeedsRecordRollback(workflow)) {
      try {
        await store.deleteTicketInstance({
          guildId: options.guildId,
          channelId: channel.id,
        });
      } catch (rollbackError) {
        console.error("Failed to roll back ticket instance", rollbackError);
        failedSteps.push("ticket-record");
      }
    }
    if (staffThreadId) {
      try {
        await (adapters.deleteStaffThread ?? adapters.deleteChannel)(staffThreadId);
      } catch (deleteError) {
        console.error("Failed to delete staff thread after open failure", deleteError);
        failedSteps.push("staff-thread");
      }
    }
    try {
      await adapters.deleteChannel(channel.id);
    } catch (deleteError) {
      console.error("Failed to delete ticket channel after open failure", deleteError);
      failedSteps.push("ticket-channel");
    }
    if (failedSteps.length > 0) {
      throw new TicketOpenRollbackError(error, failedSteps, channel.id, staffThreadId);
    }
    throw error;
  }
}

function resolveResponseRuleLinkPlatform(
  rule: TicketResponseRule,
  ticketType: TicketTypeConfig,
): TicketLinkPlatform | null {
  const condition = rule.conditions.find(
    (candidate) => candidate.kind === "lacks-platform-linked-role",
  );
  if (!condition || condition.kind !== "lacks-platform-linked-role") {
    return null;
  }
  return condition.platform ?? ticketType.defaultTicketLinkPlatform ?? null;
}

function buildOpeningMessageContent(
  ticketNumber: number,
  openerUserId: string,
  supportRoleId: string | null,
): string {
  const roleMention = supportRoleId ? ` <@&${supportRoleId}>` : "";
  return `Created ticket #${ticketNumber} for ${formatUserMention(openerUserId)}.${roleMention}`;
}
