import type { QueueBatch } from "./queue-types";
import { deleteChannel, DiscordApiError } from "../discord";

import type { TicketLifecycle, TicketRecoveryEnvelope } from "../services/tickets/ticket-lifecycle";
import type { createTicketPanelService } from "../services/tickets/ticket-panel";
import { isRecord } from "../unknown-parse";

import {
  DEFAULT_QUEUE_MAX_ATTEMPTS,
  deliverQueueBatch,
  queueDeliveryEmitter,
} from "./queue-delivery";

export const TICKET_RECOVERY_QUEUE_NAME = "haf-bot-ticket-recovery";

export async function deliverTicketRecoveryQueueBatch(
  batch: QueueBatch<unknown>,
  lifecycle: TicketLifecycle,
  panelService: Pick<ReturnType<typeof createTicketPanelService>, "resumeRecovery">,
  discordBotToken: string,
): Promise<void> {
  await deliverQueueBatch(batch, {
    maxAttempts: DEFAULT_QUEUE_MAX_ATTEMPTS,
    parse(body) {
      const recovery = parseTicketRecoveryEnvelope(body);
      return recovery
        ? { ok: true, value: recovery }
        : { ok: false, reasonCode: "invalid_ticket_recovery" };
    },
    async handle(envelope) {
      const deleteResource = (channelId: string) =>
        deleteTicketResource(channelId, discordBotToken);
      const result =
        envelope.kind === "panel-recovery"
          ? await panelService.resumeRecovery(envelope.recovery)
          : envelope.kind === "open-cleanup"
            ? await lifecycle.resumeOpenCleanup(
                { deleteChannel: deleteResource, deleteStaffThread: deleteResource },
                envelope.recovery,
              )
            : envelope.kind === "close-cleanup"
              ? await lifecycle.resumeCloseCleanup(
                  { deleteChannel: deleteResource, deleteStaffThread: deleteResource },
                  envelope.recovery,
                )
              : await lifecycle.resumeTemplateReplyCompletion(envelope.recovery);
      return result.ok
        ? { status: "complete" }
        : { status: "retry", reasonCode: "ticket_recovery_incomplete", delaySeconds: 60 };
    },
    emit: queueDeliveryEmitter(console),
  });
}

function parseTicketRecoveryEnvelope(body: unknown): TicketRecoveryEnvelope | null {
  if (!isRecord(body) || !isRecord(body.recovery)) return null;
  const recovery = body.recovery;
  if (body.kind === "panel-recovery") {
    if (
      !hasStrings(recovery, "operation", "guildId", "channelId", "messageId") ||
      !["publish", "unpublish", "delete"].includes(String(recovery.operation)) ||
      (recovery.operation === "delete"
        ? !hasStrings(recovery, "panelId")
        : !isRecord(recovery.panel))
    ) {
      return null;
    }
    return body as unknown as TicketRecoveryEnvelope;
  }
  if (body.kind === "open-cleanup") {
    if (
      !hasStrings(recovery, "guildId", "channelId") ||
      !Array.isArray(recovery.failedSteps) ||
      !recovery.failedSteps.every((step) =>
        ["ticket-record", "staff-thread", "ticket-channel"].includes(String(step)),
      )
    ) {
      return null;
    }
    return body as unknown as TicketRecoveryEnvelope;
  }
  if (body.kind === "close-cleanup") {
    if (
      !isRecord(recovery.ticket) ||
      !hasStrings(recovery.ticket, "guildId", "channelId") ||
      !hasStrings(recovery, "closedByUserId", "transcriptMessageId") ||
      typeof recovery.closedAtMs !== "number" ||
      !Array.isArray(recovery.remainingSteps) ||
      !recovery.remainingSteps.every((step) =>
        [
          "close-persistence",
          "staff-thread",
          "staff-message-cleanup",
          "staff-thread-persistence",
          "ticket-channel",
        ].includes(String(step)),
      )
    ) {
      return null;
    }
    return body as unknown as TicketRecoveryEnvelope;
  }
  if (body.kind === "template-reply-completion") {
    if (
      !hasStrings(recovery, "interactionId", "botMessageId") ||
      !isRecord(recovery.ticket) ||
      !isRecord(recovery.template)
    ) {
      return null;
    }
    return body as unknown as TicketRecoveryEnvelope;
  }
  return null;
}

function hasStrings(value: Record<string, unknown>, ...keys: string[]): boolean {
  return keys.every((key) => typeof value[key] === "string" && value[key].length > 0);
}

async function deleteTicketResource(channelId: string, discordBotToken: string): Promise<void> {
  try {
    await deleteChannel(channelId, discordBotToken);
  } catch (error) {
    if (error instanceof DiscordApiError && error.status === 404) return;
    throw error;
  }
}
