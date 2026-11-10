import {
  ticketCloseSteps,
  readTicketCloseWorkflow,
  completeTicketCloseStep,
} from "./close-workflow";
import { renderTicketTranscript, buildTicketTranscriptSummaryEmbed } from "../../tickets";
import type { TicketStore } from "../../runtime/contracts";
import type { TicketInstance, TicketPanelConfig, TicketParticipantEvent } from "../../types";
import type { TicketTranscriptBlobStore } from "../../runtime/contracts";
import type { TicketTranscriptMessage, TicketTranscriptPresentationOptions } from "../../tickets";
import type { DiscordEmbed } from "../../discord/messages";
import type { AiTranscriptSummary } from "./ai-transcript-summarizer";

export interface CloseTicketTranscriptArtifacts {
  messages: TicketTranscriptMessage[];
  presentation: TicketTranscriptPresentationOptions;
  participantEvents?: TicketParticipantEvent[];
  htmlUrl?: string;
  discard?: () => Promise<void>;
}

export class TranscriptUploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TranscriptUploadError";
  }
}

export class ChannelDeletionError extends Error {
  constructor(
    message: string,
    public readonly phase: "staff-thread" | "ticket-channel",
  ) {
    super(message);
    this.name = "ChannelDeletionError";
  }
}

export type CloseTicketRecoveryStep =
  | "close-persistence"
  | "staff-thread"
  | "staff-message-cleanup"
  | "staff-thread-persistence"
  | "ticket-channel";

export interface CloseTicketRecoveryState {
  ticket: TicketInstance;
  closedByUserId: string;
  closedAtMs: number;
  transcriptMessageId: string;
  remainingSteps: CloseTicketRecoveryStep[];
}

export class CloseTicketPartialError extends ChannelDeletionError {
  constructor(public readonly recovery: CloseTicketRecoveryState) {
    super("Ticket close completed partially", "ticket-channel");
    this.name = "CloseTicketPartialError";
  }
}

export async function closeTicket(
  store: Pick<
    TicketStore,
    "closeTicketInstance" | "cleanupStaffMessages" | "updateTicketInstanceStaffThreadId"
  >,
  adapters: {
    deleteChannel: (channelId: string) => Promise<void>;
    deleteStaffThread?: (threadId: string) => Promise<void>;
    uploadTranscript: (
      transcriptChannelId: string,
      filename: string,
      transcript: string,
      options: {
        htmlTranscriptUrl?: string;
        embeds?: DiscordEmbed[];
      },
    ) => Promise<{ id: string }>;
    buildTranscriptArtifacts: (options: {
      guildId: string;
      channelId: string;
      closingTicket: TicketInstance;
      closerDisplayName: string | null;
      ticketTranscriptBlobs?: TicketTranscriptBlobStore;
    }) => Promise<CloseTicketTranscriptArtifacts>;
    createChannelMessage?: (channelId: string, body: { content: string }) => Promise<void>;
    summarizeTranscript?: (options: {
      ticket: TicketInstance;
      panel: TicketPanelConfig;
      messages: TicketTranscriptMessage[];
      presentation: TicketTranscriptPresentationOptions;
    }) => Promise<AiTranscriptSummary | null>;
  },
  options: {
    ticket: TicketInstance;
    closedByUserId: string;
    closerDisplayName: string | null;
    panel: TicketPanelConfig;
    ticketTranscriptBlobs?: TicketTranscriptBlobStore;
    isPremiumGuild?: boolean;
  },
): Promise<void> {
  const closedAtMs = Date.now();
  const closingTicket: TicketInstance = {
    ...options.ticket,
    status: "closed",
    closedAtMs,
    closedByUserId: options.closedByUserId,
  };

  let transcriptMessageId: string;
  let transcriptArtifacts: CloseTicketTranscriptArtifacts | undefined;
  try {
    transcriptArtifacts = await adapters.buildTranscriptArtifacts({
      guildId: options.ticket.guildId,
      channelId: options.ticket.channelId,
      closingTicket,
      closerDisplayName: options.closerDisplayName,
      ticketTranscriptBlobs: options.ticketTranscriptBlobs,
    });
    const transcript = renderTicketTranscript(
      closingTicket,
      transcriptArtifacts.messages,
      transcriptArtifacts.participantEvents,
    );

    let aiSummary: AiTranscriptSummary | null = null;
    if (
      options.panel.aiTranscriptSummariesEnabled &&
      options.isPremiumGuild &&
      adapters.summarizeTranscript
    ) {
      try {
        aiSummary = await adapters.summarizeTranscript({
          ticket: closingTicket,
          panel: options.panel,
          messages: transcriptArtifacts.messages,
          presentation: transcriptArtifacts.presentation,
        });
      } catch (error) {
        console.error("Failed to generate AI transcript summary", error);
        aiSummary = null;
      }
    }

    const transcriptMessage = await adapters.uploadTranscript(
      options.panel.transcriptChannelId,
      `ticket-${options.ticket.channelId}.txt`,
      transcript,
      {
        htmlTranscriptUrl: transcriptArtifacts.htmlUrl,
        embeds: [
          buildTicketTranscriptSummaryEmbed(
            closingTicket,
            transcriptArtifacts.messages,
            transcriptArtifacts.presentation,
            aiSummary,
          ),
        ],
      },
    );
    transcriptMessageId = transcriptMessage.id;
  } catch (error) {
    console.error("Failed to upload transcript", error);
    if (transcriptArtifacts?.discard) {
      try {
        await transcriptArtifacts.discard();
      } catch (cleanupError) {
        console.error("Failed to discard unpublished transcript", cleanupError);
      }
    }
    if (adapters.createChannelMessage) {
      try {
        await adapters.createChannelMessage(options.ticket.channelId, {
          content:
            "Failed to upload the transcript for this ticket. The ticket will remain open so support staff can retry closing it.",
        });
      } catch (warningError) {
        console.error("Failed to post transcript warning", warningError);
      }
    }
    throw new TranscriptUploadError("Failed to upload transcript");
  }

  await resumeTicketCloseCleanup(store, adapters, {
    ticket: options.ticket,
    closedByUserId: options.closedByUserId,
    closedAtMs,
    transcriptMessageId,
    remainingSteps: ticketCloseSteps(options.ticket),
  });
}

/** Initial closure and queue recovery execute the same ordered state machine. */
export async function resumeTicketCloseCleanup(
  store: Pick<
    TicketStore,
    "closeTicketInstance" | "cleanupStaffMessages" | "updateTicketInstanceStaffThreadId"
  >,
  adapters: {
    deleteChannel: (id: string) => Promise<void>;
    deleteStaffThread?: (id: string) => Promise<void>;
  },
  recovery: CloseTicketRecoveryState,
): Promise<void> {
  let state = readTicketCloseWorkflow(recovery);
  while (state.kind !== "completed") {
    const { ticket } = state.recovery;
    try {
      switch (state.kind) {
        case "close-persistence":
          await store.closeTicketInstance({
            guildId: ticket.guildId,
            channelId: ticket.channelId,
            closedByUserId: recovery.closedByUserId,
            closedAtMs: recovery.closedAtMs,
            transcriptMessageId: recovery.transcriptMessageId,
          });
          break;
        case "staff-thread":
          if (ticket.staffThreadId)
            await (adapters.deleteStaffThread ?? adapters.deleteChannel)(ticket.staffThreadId);
          break;
        case "staff-message-cleanup":
          await store.cleanupStaffMessages({
            guildId: ticket.guildId,
            ticketChannelId: ticket.channelId,
          });
          break;
        case "staff-thread-persistence":
          await store.updateTicketInstanceStaffThreadId({
            guildId: ticket.guildId,
            channelId: ticket.channelId,
            staffThreadId: null,
          });
          break;
        case "ticket-channel":
          await adapters.deleteChannel(ticket.channelId);
          break;
      }
    } catch (error) {
      if (state.kind === "staff-thread")
        console.error("Failed to delete closed ticket staff thread", error);
      if (state.kind === "ticket-channel")
        console.error("Failed to delete closed ticket channel", error);
      throw new CloseTicketPartialError(state.recovery);
    }
    state = completeTicketCloseStep(state, state.kind);
  }
}
