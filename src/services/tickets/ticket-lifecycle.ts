import type { QueueProducer } from "../../runtime/queue-types";
import type {
  BlocklistStore,
  GuildEntitlementStore,
  MessageTemplateStore,
  TicketStore,
} from "../../runtime/contracts";
import { allowUserMentions, formatUserMention } from "../../discord";
import { DISCORD_BUTTON_COMPONENT, DISCORD_MESSAGE_COMPONENT_ROW } from "../../discord/constants";
import {
  buildTicketClaimCustomId,
  buildTicketCloseCustomId,
  buildTicketCloseRequestCustomId,
  formatTicketNumber,
  validateTicketAnswers,
} from "../../tickets";
import {
  getGuildEntitlementLimits,
  type TicketAnswer,
  type TicketInstance,
  type MessageTemplate,
  type TicketPanelConfig,
  type TicketTypeConfig,
} from "../../types";
import { claimTicket, deliverTicketClaim } from "./claim-ticket";
import { TicketClaimPermissionError } from "./claim-ticket";
import {
  closeTicket,
  resumeTicketCloseCleanup,
  CloseTicketPartialError,
  TranscriptUploadError,
  type CloseTicketRecoveryState,
} from "./close-ticket";
import {
  openTicket,
  TicketCreationLimitError,
  TicketPersistenceError,
  TicketOpenRollbackError,
  type TicketOpenRollbackStep,
} from "./open-ticket";
import { requestTicketClose } from "./request-ticket-close";
import type { TicketPanelRecovery } from "./ticket-panel";

export type PrepareTicketOpenResult =
  | { ok: true; panel: TicketPanelConfig; ticketType: TicketTypeConfig; answers: TicketAnswer[] }
  | { ok: false; code: "stale-config" | "permission" | "invalid-answer"; message: string };

export type ClaimTicketResult =
  | {
      ok: true;
      ticket: TicketInstance;
      claimedByUserId: string;
      claimedAtMs: number;
      alreadyClaimed: boolean;
    }
  | { ok: false; code: "missing" | "disabled" | "permission"; message: string };

export type TicketAuthorizationAction =
  | "close"
  | "request-close"
  | "confirm-close"
  | "decline-close";
export type TicketAuthorizationResult =
  | { ok: true; ticket: TicketInstance }
  | { ok: false; code: "missing" | "permission"; message: string };
export type OpenTicketResult =
  | { ok: true; ticket: TicketInstance; panel: TicketPanelConfig; ticketType: TicketTypeConfig }
  | {
      ok: false;
      code:
        | "stale-config"
        | "permission"
        | "invalid-answer"
        | "limit"
        | "provider-failure"
        | "partial-success";
      message: string;
      recovery?: OpenTicketRecovery;
    };
export interface OpenTicketRecovery {
  guildId: string;
  channelId: string;
  staffThreadId: string | null;
  failedSteps: TicketOpenRollbackStep[];
}
export type OpenTicketRecoveryResult =
  | { ok: true }
  | { ok: false; code: "partial-success"; message: string; recovery: OpenTicketRecovery };
export type CloseTicketRecovery = CloseTicketRecoveryState;
export type CloseTicketResult =
  | { ok: true }
  | {
      ok: false;
      code: "stale-config" | "transcript-failure" | "partial-success" | "provider-failure";
      message: string;
      recovery?: CloseTicketRecovery;
    };
export type TicketTemplateReplyResult =
  | { ok: true; ticket: TicketInstance; template: MessageTemplate; duplicate?: boolean }
  | {
      ok: false;
      code:
        | "unavailable"
        | "missing"
        | "permission"
        | "stale"
        | "provider-failure"
        | "partial-success";
      message: string;
      recovery?: TicketTemplateReplyRecovery;
    };
export interface TicketTemplateReplyRecovery {
  interactionId: string;
  botMessageId: string;
  ticket: TicketInstance;
  template: MessageTemplate;
}
export type TicketRecoveryEnvelope =
  | { kind: "panel-recovery"; recovery: TicketPanelRecovery }
  | { kind: "open-cleanup"; recovery: OpenTicketRecovery }
  | { kind: "close-cleanup"; recovery: CloseTicketRecovery }
  | { kind: "template-reply-completion"; recovery: TicketTemplateReplyRecovery };
export type TicketTemplateLookupResult =
  | { ok: true; template: MessageTemplate }
  | { ok: false; code: "unavailable" | "missing"; message: string };
export interface TicketParticipantAdapters {
  readAccess(channelId: string, userId: string): Promise<{ allow: string; deny: string } | null>;
  grantAccess(channelId: string, userId: string): Promise<void>;
  revokeAccess(channelId: string, userId: string): Promise<void>;
  postNeutralMessage(channelId: string, content: string): Promise<void>;
  sendInvitationDm?(userId: string, channelId: string): Promise<void>;
}
export type TicketParticipantResult =
  | { ok: true; ticket: TicketInstance; duplicate?: boolean }
  | {
      ok: false;
      code:
        | "missing"
        | "disabled"
        | "permission"
        | "invalid-target"
        | "provider-failure"
        | "partial-success";
      message: string;
    };
const TICKET_PARTICIPANT_ALLOW = String((1n << 10n) | (1n << 11n) | (1n << 16n));

export function createTicketLifecycle(options: {
  tickets: TicketStore;
  blocklist: BlocklistStore;
  entitlements: GuildEntitlementStore;
  messageTemplates?: MessageTemplateStore;
  recoveryQueue?: Pick<QueueProducer<TicketRecoveryEnvelope>, "send">;
  productAnalytics?: import("../../product-analytics").ProductAnalyticsReporter;
}) {
  return {
    async deferRecovery(recovery: TicketRecoveryEnvelope): Promise<boolean> {
      if (!options.recoveryQueue) return false;
      await options.recoveryQueue.send(recovery);
      return true;
    },
    async prepareOpen(command: {
      guildId: string;
      panelId: string;
      ticketTypeId: string;
      memberRoleIds: string[];
      answers?: TicketAnswer[];
    }): Promise<PrepareTicketOpenResult> {
      const savedPanel = await options.tickets.readTicketPanelConfigById(
        command.guildId,
        command.panelId,
      );
      const savedType = savedPanel?.ticketTypes.find((entry) => entry.id === command.ticketTypeId);
      if (!savedPanel?.panelMessageId || !savedType || savedType.enabled === false) {
        return {
          ok: false,
          code: "stale-config",
          message: "That ticket option is no longer available.",
        };
      }

      const { panel, ticketType } = await resolveEffectiveTicketConfiguration(
        options.entitlements,
        command.guildId,
        savedPanel,
        savedType,
      );
      if (!canCreateTicketType(ticketType, command.memberRoleIds)) {
        return {
          ok: false,
          code: "permission",
          message: "You do not have access to this ticket type.",
        };
      }
      if (command.answers) {
        const validationError = validateTicketAnswers(command.answers, ticketType.questions);
        if (validationError) {
          return { ok: false, code: "invalid-answer", message: validationError };
        }
      }
      return { ok: true, panel, ticketType, answers: command.answers ?? [] };
    },

    async open(
      createAdapters: (prepared: {
        panel: TicketPanelConfig;
        ticketType: TicketTypeConfig;
      }) => Parameters<typeof openTicket>[1],
      command: {
        guildId: string;
        panelId: string;
        ticketTypeId: string;
        openerUserId: string;
        openerRoleIds: string[];
        answers: TicketAnswer[];
        platformLinkConfigs?: Parameters<typeof openTicket>[2]["platformLinkConfigs"];
      },
    ): Promise<OpenTicketResult> {
      // Re-read and revalidate immediately before resource creation. prepareOpen remains useful
      // for modal presentation, but cannot be used as an authorization token for opening.
      const prepared = await this.prepareOpen({
        guildId: command.guildId,
        panelId: command.panelId,
        ticketTypeId: command.ticketTypeId,
        memberRoleIds: command.openerRoleIds,
        answers: command.answers,
      });
      if (!prepared.ok) return prepared;
      try {
        const ticket = await openTicket(
          {
            readConfig: () => options.blocklist.readConfig(),
            reserveNextTicketNumber: (guildId) => options.tickets.reserveNextTicketNumber(guildId),
            countOpenTicketsByUser: (guildId, userId) =>
              options.tickets.countOpenTicketsByUser(guildId, userId),
            createTicketInstance: (instance) => options.tickets.createTicketInstance(instance),
            deleteTicketInstance: (body) => options.tickets.deleteTicketInstance(body),
            updateTicketOpeningMessageId: (body) =>
              options.tickets.updateTicketOpeningMessageId(body),
            listMemberTicketHistory: (body) => options.tickets.listMemberTicketHistory(body),
          },
          createAdapters(prepared),
          {
            guildId: command.guildId,
            openerUserId: command.openerUserId,
            openerRoleIds: command.openerRoleIds,
            panel: prepared.panel,
            ticketType: prepared.ticketType,
            answers: prepared.answers,
            platformLinkConfigs: command.platformLinkConfigs,
          },
        );
        void options.productAnalytics?.report({
          name: "feature_outcome",
          insertionId: crypto.randomUUID(),
          guildId: command.guildId,
          feature: "tickets",
          action: "ticket_opened",
          status: "success",
        });
        return { ok: true, ticket, panel: prepared.panel, ticketType: prepared.ticketType };
      } catch (error) {
        if (error instanceof TicketCreationLimitError) {
          return { ok: false, code: "limit", message: error.rejectionMessage };
        }
        void options.productAnalytics?.report({
          name: "feature_outcome",
          insertionId: crypto.randomUUID(),
          guildId: command.guildId,
          feature: "tickets",
          action: "ticket_opened",
          status: "failure",
          reasonCode:
            error instanceof TicketPersistenceError ||
            (error instanceof TicketOpenRollbackError &&
              error.cause instanceof TicketPersistenceError)
              ? "storage_unavailable"
              : "discord_unavailable",
        });
        if (error instanceof TicketOpenRollbackError) {
          return {
            ok: false,
            code: "partial-success",
            message:
              "Ticket creation failed and cleanup was incomplete. Support must reconcile the remaining resources.",
            recovery: {
              guildId: command.guildId,
              channelId: error.channelId,
              staffThreadId: error.staffThreadId,
              failedSteps: error.failedSteps,
            },
          };
        }
        return {
          ok: false,
          code: "provider-failure",
          message: "Failed to create your ticket.",
        };
      }
    },

    async resumeOpenCleanup(
      adapters: {
        deleteChannel(channelId: string): Promise<void>;
        deleteStaffThread?(threadId: string): Promise<void>;
      },
      recovery: OpenTicketRecovery,
    ): Promise<OpenTicketRecoveryResult> {
      const failedSteps: TicketOpenRollbackStep[] = [];
      if (recovery.failedSteps.includes("ticket-record")) {
        try {
          await options.tickets.deleteTicketInstance({
            guildId: recovery.guildId,
            channelId: recovery.channelId,
          });
        } catch {
          failedSteps.push("ticket-record");
        }
      }
      if (recovery.failedSteps.includes("staff-thread") && recovery.staffThreadId) {
        try {
          await (adapters.deleteStaffThread ?? adapters.deleteChannel)(recovery.staffThreadId);
        } catch {
          failedSteps.push("staff-thread");
        }
      }
      if (recovery.failedSteps.includes("ticket-channel")) {
        try {
          await adapters.deleteChannel(recovery.channelId);
        } catch {
          failedSteps.push("ticket-channel");
        }
      }
      return failedSteps.length === 0
        ? { ok: true }
        : {
            ok: false,
            code: "partial-success",
            message: "Ticket creation cleanup is still incomplete. Retry recovery.",
            recovery: { ...recovery, failedSteps },
          };
    },

    async claim(command: {
      guildId: string;
      channelId: string;
      actorUserId: string;
      actorRoleIds: string[];
      nowMs: number;
    }): Promise<ClaimTicketResult> {
      const ticket = await options.tickets.readOpenTicketByChannel(
        command.guildId,
        command.channelId,
      );
      if (!ticket) {
        return {
          ok: false,
          code: "missing",
          message: "This ticket is already closed or missing.",
        };
      }
      const panel = await options.tickets.readTicketPanelConfigById(
        command.guildId,
        ticket.panelId ?? "main",
      );
      if (!panel?.enableTicketClaiming) {
        return {
          ok: false,
          code: "disabled",
          message: "Ticket claiming is not enabled for this server.",
        };
      }
      try {
        const claim = await claimTicket(
          { updateTicketClaim: (body) => options.tickets.updateTicketClaim(body) },
          { ticket, ...command },
        );
        return { ok: true, ticket, ...claim };
      } catch (error) {
        if (error instanceof TicketClaimPermissionError) {
          return { ok: false, code: "permission", message: error.message };
        }
        throw error;
      }
    },

    async deliverClaim(
      adapters: Parameters<typeof deliverTicketClaim>[1],
      claim: Extract<ClaimTicketResult, { ok: true }>,
    ): Promise<void> {
      await deliverTicketClaim(options.tickets, adapters, claim);
    },

    async addParticipant(
      adapters: TicketParticipantAdapters,
      command: {
        guildId: string;
        channelId: string;
        actorUserId: string;
        actorRoleIds: string[];
        isAdmin: boolean;
        targetUserId: string;
        targetIsGuildMember: boolean;
        targetIsBot: boolean;
        nowMs: number;
      },
    ): Promise<TicketParticipantResult> {
      const ticket = await options.tickets.readOpenTicketByChannel(
        command.guildId,
        command.channelId,
      );
      if (!ticket) {
        return { ok: false, code: "missing", message: "This Ticket is closed or missing." };
      }
      const panel = await options.tickets.readTicketPanelConfigById(
        command.guildId,
        ticket.panelId ?? "main",
      );
      const ticketType = panel?.ticketTypes.find((entry) => entry.id === ticket.ticketTypeId);
      if (!ticketType?.participantManagementEnabled) {
        return {
          ok: false,
          code: "disabled",
          message: "Participant management is not enabled for this Ticket type.",
        };
      }
      const isSupport =
        ticket.supportRoleId !== null && command.actorRoleIds.includes(ticket.supportRoleId);
      if (!isSupport && !command.isAdmin) {
        return {
          ok: false,
          code: "permission",
          message: "Only Ticket support staff or a Guild administrator can add participants.",
        };
      }
      if (!command.targetIsGuildMember || command.targetIsBot) {
        return {
          ok: false,
          code: "invalid-target",
          message: command.targetIsBot
            ? "Bots cannot be added as Ticket participants."
            : "That user is no longer a member of this Guild.",
        };
      }
      if (command.targetUserId === ticket.openerUserId) {
        return {
          ok: false,
          code: "invalid-target",
          message: "The Ticket opener already has access.",
        };
      }
      const existingParticipant = await options.tickets.readTicketParticipant(
        command.guildId,
        ticket.channelId,
        command.targetUserId,
      );
      if (existingParticipant) {
        const notification = await deliverParticipantNotification(
          options.tickets,
          adapters,
          existingParticipant.addedEventId,
          ticket.channelId,
          "An additional participant has been added to this Ticket.",
          command.nowMs,
        );
        return notification.ok ? { ok: true, ticket, duplicate: true } : notification;
      }

      try {
        if (await adapters.readAccess(ticket.channelId, command.targetUserId)) {
          return {
            ok: false,
            code: "invalid-target",
            message:
              "That member already has a channel-specific permission overwrite. Remove it manually before adding them as a Ticket participant.",
          };
        }
      } catch {
        return {
          ok: false,
          code: "provider-failure",
          message: "HAF could not inspect this member's existing Ticket permissions.",
        };
      }

      let participantResult: { created: boolean; eventId: string };
      try {
        await adapters.grantAccess(ticket.channelId, command.targetUserId);
      } catch {
        return {
          ok: false,
          code: "provider-failure",
          message: "HAF could not grant access to this Ticket. Check its channel permissions.",
        };
      }
      try {
        participantResult = await options.tickets.addTicketParticipant({
          guildId: command.guildId,
          ticketChannelId: ticket.channelId,
          ticketTypeId: ticket.ticketTypeId,
          userId: command.targetUserId,
          addedByUserId: command.actorUserId,
          addedAtMs: command.nowMs,
        });
      } catch {
        const concurrentlyPersisted = await options.tickets
          .readTicketParticipant(command.guildId, ticket.channelId, command.targetUserId)
          .catch(() => null);
        if (concurrentlyPersisted) {
          participantResult = { created: false, eventId: concurrentlyPersisted.addedEventId };
        } else {
          try {
            await adapters.revokeAccess(ticket.channelId, command.targetUserId);
          } catch {
            return {
              ok: false,
              code: "partial-success",
              message:
                "Participant state could not be saved, and HAF could not restore the previous channel access.",
            };
          }
          return {
            ok: false,
            code: "provider-failure",
            message: "Participant state could not be saved; channel access was restored.",
          };
        }
      }

      const notification = await deliverParticipantNotification(
        options.tickets,
        adapters,
        participantResult.eventId,
        ticket.channelId,
        "An additional participant has been added to this Ticket.",
        command.nowMs,
      );
      if (!notification.ok) return notification;
      if (participantResult.created && adapters.sendInvitationDm) {
        try {
          await adapters.sendInvitationDm(command.targetUserId, ticket.channelId);
        } catch {
          // Ticket access is authoritative; a best-effort DM must never roll it back.
        }
      }
      return { ok: true, ticket, ...(participantResult.created ? {} : { duplicate: true }) };
    },

    async removeParticipant(
      adapters: TicketParticipantAdapters,
      command: {
        guildId: string;
        channelId: string;
        actorUserId: string;
        actorRoleIds: string[];
        isAdmin: boolean;
        targetUserId: string;
        nowMs: number;
      },
    ): Promise<TicketParticipantResult> {
      const ticket = await options.tickets.readOpenTicketByChannel(
        command.guildId,
        command.channelId,
      );
      if (!ticket)
        return { ok: false, code: "missing", message: "This Ticket is closed or missing." };
      const panel = await options.tickets.readTicketPanelConfigById(
        command.guildId,
        ticket.panelId ?? "main",
      );
      const ticketType = panel?.ticketTypes.find((entry) => entry.id === ticket.ticketTypeId);
      if (!ticketType?.participantManagementEnabled) {
        return {
          ok: false,
          code: "disabled",
          message: "Participant management is not enabled for this Ticket type.",
        };
      }
      const isSupport =
        ticket.supportRoleId !== null && command.actorRoleIds.includes(ticket.supportRoleId);
      if (!isSupport && !command.isAdmin) {
        return {
          ok: false,
          code: "permission",
          message: "Only Ticket support staff or a Guild administrator can remove participants.",
        };
      }
      if (command.targetUserId === ticket.openerUserId) {
        return {
          ok: false,
          code: "invalid-target",
          message: "The Ticket opener cannot be removed.",
        };
      }
      const participant = await options.tickets.readTicketParticipant(
        command.guildId,
        ticket.channelId,
        command.targetUserId,
      );
      if (!participant) {
        const event = await options.tickets.readLatestTicketParticipantEvent({
          guildId: command.guildId,
          ticketChannelId: ticket.channelId,
          targetUserId: command.targetUserId,
          action: "participant-removed",
        });
        if (event) {
          const notification = await deliverParticipantNotification(
            options.tickets,
            adapters,
            event.id,
            ticket.channelId,
            "A participant has been removed from this Ticket.",
            command.nowMs,
          );
          if (!notification.ok) return notification;
        }
        return { ok: true, ticket, duplicate: true };
      }

      let currentAccess: { allow: string; deny: string } | null;
      try {
        currentAccess = await adapters.readAccess(ticket.channelId, command.targetUserId);
      } catch {
        return {
          ok: false,
          code: "provider-failure",
          message: "HAF could not inspect this participant's Ticket permissions.",
        };
      }
      if (
        currentAccess &&
        (currentAccess.allow !== TICKET_PARTICIPANT_ALLOW || currentAccess.deny !== "0")
      ) {
        return {
          ok: false,
          code: "invalid-target",
          message:
            "This participant's channel permissions were changed after HAF added them. Remove the overwrite manually to avoid losing those changes.",
        };
      }

      try {
        if (currentAccess) await adapters.revokeAccess(ticket.channelId, command.targetUserId);
      } catch {
        return {
          ok: false,
          code: "provider-failure",
          message: "HAF could not revoke this participant's Ticket access.",
        };
      }
      let removalResult: { removed: boolean; eventId: string | null };
      try {
        removalResult = await options.tickets.removeTicketParticipant({
          guildId: command.guildId,
          ticketChannelId: ticket.channelId,
          ticketTypeId: ticket.ticketTypeId,
          userId: command.targetUserId,
          removedByUserId: command.actorUserId,
          removedAtMs: command.nowMs,
        });
      } catch {
        if (currentAccess) {
          try {
            await adapters.grantAccess(ticket.channelId, command.targetUserId);
          } catch {
            return {
              ok: false,
              code: "partial-success",
              message:
                "Participant removal could not be saved, and HAF could not restore channel access.",
            };
          }
        }
        return {
          ok: false,
          code: "provider-failure",
          message: "Participant removal could not be saved; channel access was restored.",
        };
      }
      if (removalResult.eventId) {
        const notification = await deliverParticipantNotification(
          options.tickets,
          adapters,
          removalResult.eventId,
          ticket.channelId,
          "A participant has been removed from this Ticket.",
          command.nowMs,
        );
        if (!notification.ok) return notification;
      }
      return { ok: true, ticket, ...(removalResult.removed ? {} : { duplicate: true }) };
    },

    async authorizeTemplateReply(command: {
      guildId: string;
      channelId: string;
      actorRoleIds: string[];
      isAdmin: boolean;
    }): Promise<TicketAuthorizationResult> {
      const ticket =
        (await options.tickets.readOpenTicketByChannel(command.guildId, command.channelId)) ??
        (await options.tickets.readOpenTicketByStaffThread(command.guildId, command.channelId));
      if (!ticket) {
        return { ok: false, code: "missing", message: "This Ticket is closed or missing." };
      }
      const isSupport =
        ticket.supportRoleId !== null && command.actorRoleIds.includes(ticket.supportRoleId);
      return isSupport || command.isAdmin
        ? { ok: true, ticket }
        : {
            ok: false,
            code: "permission",
            message:
              "Only ticket support staff or a server admin can send Ticket Template Replies.",
          };
    },

    async readTemplateReply(command: {
      guildId: string;
      templateId: string;
    }): Promise<TicketTemplateLookupResult> {
      if (!options.messageTemplates) {
        return {
          ok: false,
          code: "unavailable",
          message: "Message Templates are temporarily unavailable.",
        };
      }
      const template = await options.messageTemplates.readById(command.guildId, command.templateId);
      if (!template?.availableForTicketReplies) {
        return {
          ok: false,
          code: "missing",
          message: "That Message Template is no longer available for Ticket Replies.",
        };
      }
      return { ok: true, template };
    },

    async deliverTemplateReply(
      adapters: { deliver(ticketChannelId: string, template: MessageTemplate): Promise<string> },
      command: {
        guildId: string;
        channelId: string;
        actorRoleIds: string[];
        isAdmin: boolean;
        templateId: string;
        templateUpdatedAtMs: number;
        interactionId: string;
        staffUserId: string;
        nowMs: number;
      },
    ): Promise<TicketTemplateReplyResult> {
      const authorization = await this.authorizeTemplateReply({
        guildId: command.guildId,
        channelId: command.channelId,
        actorRoleIds: command.actorRoleIds,
        isAdmin: command.isAdmin,
      });
      if (!authorization.ok) return authorization;
      const { ticket } = authorization;
      const templateResult = await this.readTemplateReply({
        guildId: command.guildId,
        templateId: command.templateId,
      });
      if (!templateResult.ok) return templateResult;
      const { template } = templateResult;
      if (template.updatedAtMs !== command.templateUpdatedAtMs) {
        return {
          ok: false,
          code: "stale",
          message:
            "This Message Template changed after the preview. Run `/ticket reply` again to review the latest content.",
        };
      }
      const claim = {
        interactionId: command.interactionId,
        guildId: command.guildId,
        ticketChannelId: ticket.channelId,
        templateId: template.id,
        templateInternalName: template.internalName,
        staffUserId: command.staffUserId,
        botMessageId: null,
        status: "pending" as const,
        createdAtMs: command.nowMs,
      };
      let claimed: boolean;
      try {
        claimed = await options.tickets.claimTicketTemplateReply(claim);
      } catch (error) {
        console.error("Failed to claim Ticket Template Reply", error);
        return {
          ok: false,
          code: "provider-failure",
          message: "Failed to send this Ticket Template Reply.",
        };
      }
      if (!claimed) return { ok: true, ticket, template, duplicate: true };
      let delivered = false;
      try {
        const botMessageId = await adapters.deliver(ticket.channelId, template);
        delivered = true;
        try {
          await options.tickets.completeTicketTemplateReply({
            interactionId: command.interactionId,
            botMessageId,
          });
        } catch (error) {
          console.error("Failed to persist Ticket Template Reply completion", error);
          return {
            ok: false,
            code: "partial-success",
            message: "The Ticket Template Reply was sent, but its delivery record is incomplete.",
            recovery: { interactionId: command.interactionId, botMessageId, ticket, template },
          };
        }
        return { ok: true, ticket, template };
      } catch (error) {
        if (!delivered) await options.tickets.releaseTicketTemplateReply(command.interactionId);
        console.error("Failed to send Ticket Template Reply", error);
        return {
          ok: false,
          code: "provider-failure",
          message: "Failed to send this Ticket Template Reply.",
        };
      }
    },

    async resumeTemplateReplyCompletion(
      recovery: TicketTemplateReplyRecovery,
    ): Promise<TicketTemplateReplyResult> {
      try {
        await options.tickets.completeTicketTemplateReply({
          interactionId: recovery.interactionId,
          botMessageId: recovery.botMessageId,
        });
        return { ok: true, ticket: recovery.ticket, template: recovery.template };
      } catch {
        return {
          ok: false,
          code: "partial-success",
          message: "The Ticket Template Reply delivery record is still incomplete.",
          recovery,
        };
      }
    },

    async authorize(command: {
      guildId: string;
      channelId: string;
      actorUserId: string;
      actorRoleIds: string[];
      action: TicketAuthorizationAction;
    }): Promise<TicketAuthorizationResult> {
      const ticket = await options.tickets.readOpenTicketByChannel(
        command.guildId,
        command.channelId,
      );
      if (!ticket) {
        return {
          ok: false,
          code: "missing",
          message: "This ticket is already closed or missing.",
        };
      }
      const isOpener = ticket.openerUserId === command.actorUserId;
      const isSupport =
        ticket.supportRoleId !== null && command.actorRoleIds.includes(ticket.supportRoleId);
      if (command.action === "close" && !isOpener && !isSupport) {
        return {
          ok: false,
          code: "permission",
          message: "Only the ticket opener or the configured support role can close this ticket.",
        };
      }
      if (command.action === "request-close") {
        if (isOpener) {
          return {
            ok: false,
            code: "permission",
            message: "You can close your own ticket directly.",
          };
        }
        if (!isSupport) {
          return {
            ok: false,
            code: "permission",
            message:
              "Only the configured support role can request that the ticket opener close this ticket.",
          };
        }
      }
      if ((command.action === "confirm-close" || command.action === "decline-close") && !isOpener) {
        return {
          ok: false,
          code: "permission",
          message: `Only the ticket opener can ${command.action === "confirm-close" ? "approve" : "decline"} this close request.`,
        };
      }
      return { ok: true, ticket };
    },

    requestClose(
      adapters: Parameters<typeof requestTicketClose>[0],
      command: Parameters<typeof requestTicketClose>[1],
    ) {
      return requestTicketClose(adapters, command);
    },

    async close(
      adapters: Parameters<typeof closeTicket>[1],
      command: Omit<Parameters<typeof closeTicket>[2], "panel" | "isPremiumGuild">,
    ): Promise<CloseTicketResult> {
      const panel = await options.tickets.readTicketPanelConfigById(
        command.ticket.guildId,
        command.ticket.panelId ?? "main",
      );
      if (!panel) {
        return {
          ok: false,
          code: "stale-config",
          message: "This ticket panel configuration is missing.",
        };
      }
      const entitlement = await options.entitlements.readGuildEntitlement(command.ticket.guildId);
      try {
        await closeTicket(
          {
            closeTicketInstance: (body) => options.tickets.closeTicketInstance(body),
            cleanupStaffMessages: (body) => options.tickets.cleanupStaffMessages(body),
            updateTicketInstanceStaffThreadId: (body) =>
              options.tickets.updateTicketInstanceStaffThreadId(body),
          },
          adapters,
          {
            ...command,
            panel,
            isPremiumGuild: getGuildEntitlementLimits(entitlement.tier).paidFeatures,
          },
        );
        void options.productAnalytics?.report({
          name: "feature_outcome",
          insertionId: crypto.randomUUID(),
          guildId: command.ticket.guildId,
          feature: "tickets",
          action: "ticket_closed",
          status: "success",
        });
        void options.productAnalytics?.report({
          name: "feature_outcome",
          insertionId: crypto.randomUUID(),
          guildId: command.ticket.guildId,
          feature: "tickets",
          action: "transcript_archived",
          status: "success",
        });
        return { ok: true };
      } catch (error) {
        void options.productAnalytics?.report({
          name: "feature_outcome",
          insertionId: crypto.randomUUID(),
          guildId: command.ticket.guildId,
          feature: "tickets",
          action: error instanceof TranscriptUploadError ? "transcript_archived" : "ticket_closed",
          status: "failure",
          reasonCode:
            error instanceof TranscriptUploadError || error instanceof CloseTicketPartialError
              ? "storage_unavailable"
              : "discord_unavailable",
        });
        if (error instanceof TranscriptUploadError) {
          return {
            ok: false,
            code: "transcript-failure",
            message:
              "Failed to upload the transcript. The ticket is still open, and a warning was posted in the channel.",
          };
        }
        if (error instanceof CloseTicketPartialError) {
          const persistencePending = error.recovery.remainingSteps[0] === "close-persistence";
          return {
            ok: false,
            code: "partial-success",
            message: persistencePending
              ? "Uploaded the transcript, but failed to save the closed ticket state. The ticket remains open while recovery is attempted."
              : "Closed ticket and uploaded the transcript, but failed to delete the channel. Please clean it up manually.",
            recovery: error.recovery,
          };
        }
        return {
          ok: false,
          code: "provider-failure",
          message: error instanceof Error ? error.message : "Failed to close the ticket.",
        };
      }
    },

    async resumeCloseCleanup(
      adapters: Pick<Parameters<typeof closeTicket>[1], "deleteChannel" | "deleteStaffThread">,
      recovery: CloseTicketRecovery,
    ): Promise<CloseTicketResult> {
      try {
        await resumeTicketCloseCleanup(options.tickets, adapters, recovery);
        return { ok: true };
      } catch (error) {
        if (error instanceof CloseTicketPartialError) {
          return {
            ok: false,
            code: "partial-success",
            message:
              error.recovery.remainingSteps[0] === "close-persistence"
                ? "Uploaded the transcript, but failed to save the closed ticket state. The ticket remains open while recovery is attempted."
                : "Closed ticket and uploaded the transcript, but failed to delete the channel. Please clean it up manually.",
            recovery: error.recovery,
          };
        }
        return { ok: false, code: "provider-failure", message: "Failed to resume ticket cleanup." };
      }
    },
  };
}

export type TicketLifecycle = ReturnType<typeof createTicketLifecycle>;

async function deliverParticipantNotification(
  tickets: TicketStore,
  adapters: TicketParticipantAdapters,
  eventId: string,
  channelId: string,
  content: string,
  nowMs: number,
): Promise<{ ok: true } | Extract<TicketParticipantResult, { ok: false }>> {
  if (!(await tickets.claimTicketParticipantNotification(eventId, nowMs))) return { ok: true };
  try {
    await adapters.postNeutralMessage(channelId, content);
    await tickets.completeTicketParticipantNotification(eventId, nowMs);
    return { ok: true };
  } catch {
    await tickets.releaseTicketParticipantNotification(eventId, nowMs).catch(() => undefined);
    return {
      ok: false,
      code: "partial-success",
      message:
        "Participant access changed, but the Ticket notification is incomplete. Retry the command to complete it.",
    };
  }
}

async function resolveEffectiveTicketConfiguration(
  entitlements: GuildEntitlementStore,
  guildId: string,
  panel: TicketPanelConfig,
  ticketType: TicketTypeConfig,
): Promise<{ panel: TicketPanelConfig; ticketType: TicketTypeConfig }> {
  const entitlement = await entitlements.readGuildEntitlement(guildId);
  if (getGuildEntitlementLimits(entitlement.tier).paidFeatures) return { panel, ticketType };
  return {
    panel: {
      ...panel,
      ticketCreationLimit: 1,
      ticketLimitRejectionMessage: null,
      aiTranscriptSummariesEnabled: false,
    },
    ticketType: {
      ...ticketType,
      allowedCreatorRoleIds: [],
      responseRules: [],
      defaultTicketLinkPlatform: null,
      anonymousSupportEnabled: false,
      staffDiscussionThreadEnabled: false,
      ticketHistoryPromptVisibility: "off",
      limitExclusion: false,
    },
  };
}

function canCreateTicketType(ticketType: TicketTypeConfig, memberRoleIds: string[]): boolean {
  const allowedRoleIds = ticketType.allowedCreatorRoleIds ?? [];
  return (
    allowedRoleIds.length === 0 || allowedRoleIds.some((roleId) => memberRoleIds.includes(roleId))
  );
}

export function buildTicketOpeningMessage(
  instance: TicketInstance,
  ticketNumber: number,
  options: { enableTicketClaiming?: boolean; mentionSupportRole?: boolean } = {},
) {
  const fields = instance.answers.map((answer) => ({
    name: answer.label,
    value: answer.value || "(blank)",
  }));
  const actionButtons: Array<{
    type: typeof DISCORD_BUTTON_COMPONENT;
    custom_id: string;
    label: string;
    style: 2 | 4;
  }> = [];
  if (instance.supportRoleId) {
    actionButtons.push({
      type: DISCORD_BUTTON_COMPONENT,
      custom_id: buildTicketCloseRequestCustomId(instance.channelId),
      label: "Request Close",
      style: 2,
    });
  }
  actionButtons.push({
    type: DISCORD_BUTTON_COMPONENT,
    custom_id: buildTicketCloseCustomId(instance.channelId),
    label: "Close Ticket",
    style: 4,
  });
  const components: Array<{ type: typeof DISCORD_MESSAGE_COMPONENT_ROW; components: unknown[] }> =
    [];
  if (options.enableTicketClaiming) {
    components.push({
      type: DISCORD_MESSAGE_COMPONENT_ROW,
      components: [
        {
          type: DISCORD_BUTTON_COMPONENT,
          custom_id: buildTicketClaimCustomId(instance.channelId),
          label: instance.claimedByUserId
            ? `Claimed by @${instance.claimedByUserId}`
            : "Claim Ticket",
          style: 2,
        },
      ],
    });
  }
  components.push({ type: DISCORD_MESSAGE_COMPONENT_ROW, components: actionButtons });
  const supportRoleMention =
    options.mentionSupportRole && instance.supportRoleId ? ` <@&${instance.supportRoleId}>` : "";
  return {
    content: `${formatUserMention(instance.openerUserId)}${supportRoleMention}`,
    allowed_mentions:
      options.mentionSupportRole && instance.supportRoleId
        ? { parse: [], users: [instance.openerUserId], roles: [instance.supportRoleId] }
        : allowUserMentions([instance.openerUserId]),
    embeds: [
      {
        title: `${instance.ticketTypeLabel} Ticket #${formatTicketNumber(ticketNumber)}`,
        color: 0x2ecc71,
        fields: [{ name: "User", value: formatUserMention(instance.openerUserId) }, ...fields],
        footer: { text: `Ticket type: ${instance.ticketTypeId}` },
        timestamp: new Date(instance.openedAtMs).toISOString(),
      },
    ],
    components,
  };
}
