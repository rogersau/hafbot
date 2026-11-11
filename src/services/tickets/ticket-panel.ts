import type { QueueProducer } from "../../runtime/queue-types";
import {
  createChannelMessage,
  deleteChannelMessage,
  DiscordApiError,
  editChannelMessage,
  type GuildTicketResources,
} from "../../discord";
import { DISCORD_BUTTON_COMPONENT, DISCORD_MESSAGE_COMPONENT_ROW } from "../../discord/constants";
import type {
  GuildResourceScope,
  GuildResourceValidator,
} from "../../discord/guild-resource-validator";
import { GuildResourceValidationError } from "../../discord/guild-resource-validator";
import { buildAuditEmbed, suppressMentions } from "../../discord/messages";
import type {
  GuildAuditLogStore,
  GuildEntitlementStore,
  TicketStore,
} from "../../runtime/contracts";
import type { TicketTestAction, TicketTestActionResponse } from "../../runtime/admin-types";
import {
  canonicalConfigurationJson,
  diffConfigurationSnapshots,
  hashConfigurationSnapshot,
  serializeTicketPanelConfiguration,
  type ConfigurationActorContext,
  type ConfigurationRevisionDetail,
  type ConfigurationRevisionStore,
  type ConfigurationSnapshotEnvelope,
  type TicketPanelSnapshot,
} from "../../configuration-revisions";
import { ticketPanelRevisionAdapter } from "../../configuration-revisions/adapters";
import { commitVersionedConfigurationMutation } from "../../configuration-revisions/coordinator";
import {
  signConfigurationRestoreToken,
  verifyConfigurationRestoreToken,
} from "../../configuration-revisions/restore-token";
import { buildTicketOpenCustomId } from "../../tickets";
import { firstTicketModalFieldValidationIssue } from "../../tickets/validation";
import { isRecord } from "../../unknown-parse";
import {
  getGuildEntitlementLimits,
  type TicketPanelConfig,
  type TicketTypeConfig,
} from "../../types";
import { resolveAuditChannelId } from "../guild-audit-log-service";
import {
  buildTicketPanelDiagnostics,
  type TicketPanelDiagnosticsInput,
} from "./ticket-panel-diagnostics";
import type { TicketRecoveryEnvelope } from "./ticket-lifecycle";

export interface TicketPanelDiscordAdapter {
  publish(panel: TicketPanelConfig, message: TicketPanelMessage): Promise<string>;
  deleteMessage(guildId: string, channelId: string, messageId: string): Promise<void>;
  recordConfigChange(panel: TicketPanelConfig): Promise<void>;
}

export interface TicketPanelServiceOptions {
  store: TicketStore;
  entitlements: GuildEntitlementStore;
  guildResources: GuildResourceValidator;
  discord: TicketPanelDiscordAdapter;
  createId?: () => string;
  recoveryQueue?: Pick<QueueProducer<TicketRecoveryEnvelope>, "send">;
  configurationRevisions?: ConfigurationRevisionStore;
}

export interface TicketPanelTestAdapters {
  postPanelMessage(channelId: string): Promise<void>;
  uploadTranscript(channelId: string): Promise<void>;
  aiSummariesAvailable: boolean;
  testAiSummary(panel: TicketPanelConfig): Promise<boolean>;
  formatError(error: unknown): string;
}

export function createDiscordTicketPanelAdapter(options: {
  discordBotToken: string;
  auditStore: GuildAuditLogStore;
  guildResources: GuildResourceValidator;
}): TicketPanelDiscordAdapter {
  return {
    async publish(panel, message) {
      await options.guildResources.requireTextChannel(panel.guildId, panel.panelChannelId);
      if (panel.panelMessageId) {
        try {
          const refreshed = await editChannelMessage(
            panel.panelChannelId,
            panel.panelMessageId,
            message,
            options.discordBotToken,
          );
          return refreshed.id;
        } catch (error) {
          if (!(error instanceof DiscordApiError) || error.status !== 404) throw error;
        }
      }
      const created = await createChannelMessage(
        panel.panelChannelId,
        message,
        options.discordBotToken,
      );
      return created.id;
    },
    async deleteMessage(guildId, channelId, messageId) {
      try {
        const channel = await options.guildResources.requireTextChannel(guildId, channelId);
        if (channel.guild_id && channel.guild_id !== guildId) return;
        await deleteChannelMessage(channelId, messageId, options.discordBotToken);
      } catch (error) {
        // Deletion is deliberately idempotent so a persistence-failure retry can finish.
        if (error instanceof DiscordApiError && error.status === 404) return;
        // A channel deleted out-of-band is already absent. Publishing remains strict;
        // this exception is limited to the cleanup adapter boundary.
        if (error instanceof GuildResourceValidationError) return;
        throw error;
      }
    },
    async recordConfigChange(panel) {
      const auditChannelId = await resolveAuditChannelId(
        panel.guildId,
        null,
        options.auditStore,
        "ticket.panel-config-change",
      );
      if (!auditChannelId) return;
      try {
        await options.guildResources.requireTextChannel(panel.guildId, auditChannelId);
        await createChannelMessage(
          auditChannelId,
          {
            embeds: [
              buildAuditEmbed({
                title: "Ticket Panel Config Change",
                color: 0x5865f2,
                fields: [
                  { name: "Panel", value: panel.panelName || panel.panelId || "main" },
                  { name: "Ticket Types", value: String(panel.ticketTypes.length) },
                ],
              }),
            ],
            allowed_mentions: suppressMentions(),
          },
          options.discordBotToken,
        );
      } catch (error) {
        console.error("Failed to post ticket panel audit event", error);
      }
    },
  };
}

export type TicketPanelFailureCode =
  | "not-found"
  | "plan-limit"
  | "invalid-target"
  | "invalid-panel"
  | "provider-failure"
  | "persistence-failure"
  | "partial-success"
  | "open-tickets";

export type TicketPanelResult<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      code: TicketPanelFailureCode;
      message: string;
      recovery?: TicketPanelRecovery;
    };

export type TicketPanelRecovery =
  | {
      operation: "publish" | "unpublish";
      guildId: string;
      panel: TicketPanelConfig;
      channelId: string;
      messageId: string;
    }
  | {
      operation: "delete";
      guildId: string;
      panelId: string;
      channelId: string;
      messageId: string;
    };

export interface TicketPanelMessage {
  content: string;
  embeds: Array<{
    color: number;
    title?: string;
    description?: string;
    footer?: { text: string };
  }>;
  components: Array<{
    type: number;
    components: Array<{
      type: number;
      custom_id: string;
      label: string;
      style: 1 | 2 | 3 | 4;
      emoji?: { name: string };
    }>;
  }>;
}

export function createTicketPanelService(options: TicketPanelServiceOptions) {
  const readPanel = async (guildId: string, panelId: string): Promise<TicketPanelConfig | null> =>
    options.store.readTicketPanelConfigById(guildId, panelId);

  const listPanels = async (guildId: string): Promise<TicketPanelConfig[]> =>
    options.store.listTicketPanelConfigs(guildId);

  const readGuildResources = async (guildId: string): Promise<GuildResourceScope> =>
    options.guildResources.forGuild(guildId);

  const cleanupPublishedPanelMessage = async (panel: TicketPanelConfig): Promise<void> => {
    if (!panel.panelMessageId) return;

    // Cleanup is intentionally tolerant of a channel that disappeared after publication.
    // The resource validator remains strict for publishing and all other writes; this
    // narrow preflight prevents a stale or cross-Guild channel ID from reaching Discord.
    try {
      const resources = await readGuildResources(panel.guildId);
      const channel = resources.requireTextChannel(panel.panelChannelId);
      if (channel.guild_id && channel.guild_id !== panel.guildId) return;
    } catch (error) {
      if (error instanceof GuildResourceValidationError) return;
      throw error;
    }

    try {
      await options.discord.deleteMessage(
        panel.guildId,
        panel.panelChannelId,
        panel.panelMessageId,
      );
    } catch (error) {
      // A message deleted out-of-band is already in the desired cleanup state.
      if (error instanceof DiscordApiError && error.status === 404) return;
      throw error;
    }
  };

  const requirePanelResources = (panel: TicketPanelConfig, resources: GuildResourceScope): void => {
    resources.requireTextChannel(panel.panelChannelId);
    resources.requireCategory(panel.categoryChannelId);
    resources.requireTextChannel(panel.transcriptChannelId);
    for (const ticketType of panel.ticketTypes) {
      resources.requireRole(ticketType.supportRoleId);
      resources.requireRoles(ticketType.allowedCreatorRoleIds ?? []);
    }
  };

  const enforceMutation = async (
    candidate: TicketPanelConfig,
  ): Promise<TicketPanelResult<TicketPanelConfig>> => {
    const modalFieldError = firstTicketModalFieldValidationIssue(candidate);
    if (modalFieldError) {
      return { ok: false, code: "invalid-panel", message: modalFieldError.message };
    }
    const entitlement = await options.entitlements.readGuildEntitlement(candidate.guildId);
    const limits = getGuildEntitlementLimits(entitlement.tier);
    if (limits.paidFeatures) return { ok: true, value: candidate };

    const panelId = candidate.panelId ?? "main";
    const saved = await readPanel(candidate.guildId, panelId);
    if (!saved && typeof limits.ticketsMaxPanels === "number") {
      const panels = await listPanels(candidate.guildId);
      if (panels.length >= limits.ticketsMaxPanels) {
        return planLimit(
          `The Free plan supports ${limits.ticketsMaxPanels} Ticket Panel. Delete the existing panel or upgrade to create another.`,
        );
      }
    }

    const typeLimit = limits.ticketsMaxTypesPerPanel;
    if (
      typeof typeLimit === "number" &&
      ((!saved && candidate.ticketTypes.length > typeLimit) ||
        (saved &&
          candidate.ticketTypes.length > saved.ticketTypes.length &&
          (saved.ticketTypes.length >= typeLimit || candidate.ticketTypes.length > typeLimit)))
    ) {
      return planLimit(
        `The Free plan supports ${typeLimit} Ticket Type per panel. Remove an existing type or upgrade to add another.`,
      );
    }

    const paidControl = findChangedPaidTicketControl(candidate, saved);
    if (paidControl) return planLimit(`${paidControl} requires a paid plan.`);
    if (saved) return { ok: true, value: candidate };
    return {
      ok: true,
      value: applyFreePanelDefaults(candidate),
    };
  };

  const persistTicketPanelMutation = async (
    currentPanel: TicketPanelConfig | null,
    nextPanel: TicketPanelConfig | null,
    actor?: ConfigurationActorContext,
    revision?: {
      operation: "restore";
      restoredFromRevisionId: string;
    },
  ): Promise<void> => {
    const panel = nextPanel ?? currentPanel;
    if (!panel) throw new Error("Ticket Panel mutation needs current or next state.");
    const entitlement = await options.entitlements.readGuildEntitlement(panel.guildId);
    const paid = getGuildEntitlementLimits(entitlement.tier).paidFeatures;
    if (!paid) {
      if (nextPanel) {
        await options.store.upsertTicketPanelConfig(nextPanel);
      } else {
        await options.store.deleteTicketPanelConfig(panel.guildId, panel.panelId ?? "main");
      }
      return;
    }
    if (!options.configurationRevisions) {
      throw new Error("Configuration revision storage is unavailable for this Premium Guild.");
    }
    await commitVersionedConfigurationMutation({
      revisions: options.configurationRevisions,
      entitlements: options.entitlements,
      mutation: {
        guildId: panel.guildId,
        feature: "tickets",
        resourceKey: panel.panelId ?? "main",
        current: currentPanel,
        next: nextPanel,
        adapter: ticketPanelRevisionAdapter,
        actor: actor ?? {
          actorUserId: null,
          source: "dashboard-save",
          operationId: "ticketsPanel.post",
          correlationId: null,
        },
        operation: revision?.operation,
        restoredFromRevisionId: revision?.restoredFromRevisionId,
      },
      commitFree: async () => {
        if (nextPanel) await options.store.upsertTicketPanelConfig(nextPanel);
        else await options.store.deleteTicketPanelConfig(panel.guildId, panel.panelId ?? "main");
      },
    });
  };

  const prepareRestoreState = async (input: {
    guildId: string;
    revisionId: string;
    resources: GuildTicketResources;
  }) => {
    if (!options.configurationRevisions) {
      throw new Error("Configuration revision storage is unavailable.");
    }
    const entitlement = await options.entitlements.readGuildEntitlement(input.guildId);
    const limits = getGuildEntitlementLimits(entitlement.tier);
    if (!limits.paidFeatures) {
      throw new Error("Configuration revision restore requires a Premium plan.");
    }
    const targetRevision = await options.configurationRevisions.readById({
      guildId: input.guildId,
      revisionId: input.revisionId,
    });
    if (!targetRevision || targetRevision.feature !== "tickets") {
      throw new Error("Ticket Panel revision not found.");
    }
    const head = await options.configurationRevisions.readHead({
      guildId: input.guildId,
      feature: "tickets",
      resourceKey: targetRevision.resourceKey,
    });
    if (!head) throw new Error("Ticket Panel revision head not found.");
    const currentPanel = await readPanel(input.guildId, targetRevision.resourceKey);
    const parsed = JSON.parse(
      targetRevision.snapshotJson,
    ) as ConfigurationSnapshotEnvelope<unknown>;
    const targetSnapshot = ticketPanelRevisionAdapter.parseSnapshot(parsed);
    let targetPanel = targetSnapshot.exists
      ? ticketSnapshotToPanel(
          input.guildId,
          targetSnapshot.value!,
          currentPanel?.panelMessageId ?? null,
        )
      : null;
    if (targetPanel) {
      const enforced = await enforceMutation(targetPanel);
      if (!enforced.ok) throw new Error(enforced.message);
      targetPanel = enforced.value;
      requirePanelResources(targetPanel, await readGuildResources(targetPanel.guildId));
      const missing = getMissingTicketPanelTargets(targetPanel, input.resources, true);
      if (missing.length > 0) {
        throw new Error("Ticket Panel revision references invalid Discord resources.");
      }
    }
    const currentSnapshot = serializeTicketPanelConfiguration(
      currentPanel,
      targetRevision.resourceKey,
    );
    return {
      resourceKey: targetRevision.resourceKey,
      currentPanel,
      targetPanel,
      targetSnapshot,
      head,
      currentSnapshotHash: await hashConfigurationSnapshot(currentSnapshot),
      targetSnapshotHash: await hashConfigurationSnapshot(targetSnapshot),
      entitlementTier: entitlement.tier,
    };
  };

  return {
    async deferRecovery(recovery: TicketPanelRecovery): Promise<boolean> {
      if (!options.recoveryQueue) return false;
      await options.recoveryQueue.send({ kind: "panel-recovery", recovery });
      return true;
    },
    diagnose(input: TicketPanelDiagnosticsInput) {
      return buildTicketPanelDiagnostics(input);
    },
    async testAction(
      command: { guildId: string; panelId?: string; action: TicketTestAction },
      adapters: TicketPanelTestAdapters,
    ): Promise<TicketTestActionResponse> {
      const panel = await readPanel(command.guildId, command.panelId ?? "main");
      if (!panel) {
        return {
          ok: false,
          action: command.action,
          status: "failed",
          message: "Save a ticket panel before running test actions.",
        };
      }
      if (command.action === "panel-post" && panel.panelChannelId) {
        (await readGuildResources(command.guildId)).requireTextChannel(panel.panelChannelId);
      }
      if (command.action === "transcript-upload" && panel.transcriptChannelId) {
        (await readGuildResources(command.guildId)).requireTextChannel(panel.transcriptChannelId);
      }
      try {
        if (command.action === "panel-post") {
          if (!panel.panelChannelId)
            return skipped(command.action, "Choose a panel channel before running this test.");
          await adapters.postPanelMessage(panel.panelChannelId);
          return succeeded(
            command.action,
            "Success: a test message was posted in the panel channel.",
          );
        }
        if (command.action === "transcript-upload") {
          if (!panel.transcriptChannelId)
            return skipped(command.action, "Choose a transcript channel before running this test.");
          await adapters.uploadTranscript(panel.transcriptChannelId);
          return succeeded(
            command.action,
            "Success: a test transcript was uploaded to the transcript channel.",
          );
        }
        const entitlement = await options.entitlements.readGuildEntitlement(command.guildId);
        if (!getGuildEntitlementLimits(entitlement.tier).paidFeatures) {
          return skipped(command.action, "AI Transcript Summary requires a paid plan.");
        }
        if (!panel.aiTranscriptSummariesEnabled) {
          return skipped(
            command.action,
            "Turn on AI transcript summaries for this panel before testing.",
          );
        }
        if (!adapters.aiSummariesAvailable) {
          return skipped(
            command.action,
            "AI summaries are currently unavailable. Ticket transcripts will still be created.",
          );
        }
        if (!(await adapters.testAiSummary(panel))) {
          return failed(
            command.action,
            "AI summaries are currently unavailable. Ticket transcripts will still be created.",
          );
        }
        return succeeded(command.action, "Success: AI summaries are available for closed tickets.");
      } catch (error) {
        return failed(command.action, adapters.formatError(error));
      }
    },
    async createPanel(
      command: {
        guildId: string;
        mode: "blank" | "clone";
        sourcePanelId?: string;
      },
      actor?: ConfigurationActorContext,
    ): Promise<TicketPanelResult<TicketPanelConfig>> {
      const panels = await listPanels(command.guildId);
      const entitlement = await options.entitlements.readGuildEntitlement(command.guildId);
      const panelLimit = getGuildEntitlementLimits(entitlement.tier).ticketsMaxPanels;
      if (typeof panelLimit === "number" && panels.length >= panelLimit) {
        return planLimit(
          `The Free plan supports ${panelLimit} Ticket Panel. Delete the existing panel or upgrade to create another.`,
        );
      }
      const source =
        command.mode === "clone"
          ? await readPanel(command.guildId, command.sourcePanelId ?? "main")
          : null;
      if (command.mode === "clone" && !source) {
        return { ok: false, code: "not-found", message: "Source ticket panel not found." };
      }

      const panel = createDraftPanel(
        command.guildId,
        panels,
        source,
        options.createId ?? (() => crypto.randomUUID()),
      );
      if (typeof panelLimit === "number") panel.ticketCreationLimit = 1;
      const enforced = await enforceMutation(panel);
      if (!enforced.ok) return enforced;
      const nextPanel = enforced.value;
      if (source) {
        const resources = await readGuildResources(command.guildId);
        resources.requireCategory(nextPanel.categoryChannelId);
        resources.requireTextChannel(nextPanel.transcriptChannelId);
        for (const ticketType of nextPanel.ticketTypes) {
          resources.requireRole(ticketType.supportRoleId);
          resources.requireRoles(ticketType.allowedCreatorRoleIds ?? []);
        }
      }
      await persistTicketPanelMutation(null, nextPanel, actor);
      await options.discord.recordConfigChange(nextPanel);
      return { ok: true, value: nextPanel };
    },

    async savePanel(
      candidate: TicketPanelConfig,
      actor?: ConfigurationActorContext,
    ): Promise<TicketPanelResult<TicketPanelConfig>> {
      const saved = await readPanel(candidate.guildId, candidate.panelId ?? "main");
      const moveFailure = publishedPanelMoveFailure(candidate, saved);
      if (moveFailure) return moveFailure;
      const normalized = preservePublication(candidate, saved);
      const result = await enforceMutation(normalized);
      if (!result.ok) return result;
      requirePanelResources(result.value, await readGuildResources(result.value.guildId));
      await persistTicketPanelMutation(saved, result.value, actor);
      await options.discord.recordConfigChange(result.value);
      return result;
    },

    async publishPanel(command: {
      panel: TicketPanelConfig;
      resources: GuildTicketResources;
    }): Promise<TicketPanelResult<{ panel: TicketPanelConfig; panelMessageId: string }>> {
      const saved = await readPanel(command.panel.guildId, command.panel.panelId ?? "main");
      const moveFailure = publishedPanelMoveFailure(command.panel, saved);
      if (moveFailure) return moveFailure;
      const normalized = preservePublication(command.panel, saved);
      const result = await enforceMutation(normalized);
      if (!result.ok) return result;
      const panel = result.value;
      requirePanelResources(panel, await readGuildResources(panel.guildId));
      if (panel.ticketTypes.length === 0) {
        return {
          ok: false,
          code: "invalid-panel",
          message: "Publishing requires at least one ticket type.",
        };
      }
      const entitlement = await options.entitlements.readGuildEntitlement(panel.guildId);
      const missing = getMissingTicketPanelTargets(
        panel,
        command.resources,
        getGuildEntitlementLimits(entitlement.tier).paidFeatures,
      );
      if (missing.length > 0) {
        return {
          ok: false,
          code: "invalid-target",
          message: "Ticket panel configuration references invalid Discord resources.",
        };
      }
      let panelMessageId: string;
      try {
        panelMessageId = await options.discord.publish(panel, buildTicketPanelMessage(panel));
      } catch (error) {
        return {
          ok: false,
          code: "provider-failure",
          message: error instanceof Error ? error.message : "Failed to publish the ticket panel.",
        };
      }
      const published = { ...panel, panelMessageId };
      try {
        await options.store.upsertTicketPanelConfig(published);
      } catch {
        const compensated = await compensateFailedPublish(
          options.discord,
          saved,
          panel.guildId,
          panel.panelChannelId,
          panelMessageId,
        );
        return {
          ok: false,
          code: compensated ? "persistence-failure" : "partial-success",
          message: compensated
            ? "The panel could not be saved, so its Discord publication was rolled back. Retry publishing."
            : "The Discord panel changed but its saved configuration did not. Retry publishing to reconcile it.",
          ...(!compensated
            ? {
                recovery: {
                  operation: "publish" as const,
                  guildId: panel.guildId,
                  panel: published,
                  channelId: panel.panelChannelId,
                  messageId: panelMessageId,
                },
              }
            : {}),
        };
      }
      await options.discord.recordConfigChange(published);
      return { ok: true, value: { panel: published, panelMessageId } };
    },

    async unpublishPanel(command: {
      guildId: string;
      panelId: string;
    }): Promise<TicketPanelResult<TicketPanelConfig>> {
      const panel = await readPanel(command.guildId, command.panelId);
      if (!panel) return { ok: false, code: "not-found", message: "Ticket panel not found." };
      try {
        await cleanupPublishedPanelMessage(panel);
      } catch (error) {
        return {
          ok: false,
          code: "provider-failure",
          message:
            error instanceof Error ? error.message : "Failed to delete the ticket panel message.",
        };
      }
      const unpublished = { ...panel, panelMessageId: null };
      try {
        await options.store.upsertTicketPanelConfig(unpublished);
        return { ok: true, value: unpublished };
      } catch {
        return {
          ok: false,
          code: "partial-success",
          message:
            "The Discord panel was removed, but its saved publication state was not cleared. Retry unpublishing to reconcile it.",
          ...(panel.panelMessageId
            ? {
                recovery: {
                  operation: "unpublish" as const,
                  guildId: panel.guildId,
                  panel: unpublished,
                  channelId: panel.panelChannelId,
                  messageId: panel.panelMessageId,
                },
              }
            : {}),
        };
      }
    },

    async deletePanel(
      command: {
        guildId: string;
        panelId: string;
      },
      actor?: ConfigurationActorContext,
    ): Promise<TicketPanelResult<undefined>> {
      const openTickets = await options.store.countOpenTicketsForPanel(
        command.guildId,
        command.panelId,
      );
      if (openTickets > 0) {
        return {
          ok: false,
          code: "open-tickets",
          message: "Cannot delete a ticket panel while it has open tickets.",
        };
      }
      const panel = await readPanel(command.guildId, command.panelId);
      try {
        if (panel) await cleanupPublishedPanelMessage(panel);
      } catch (error) {
        return {
          ok: false,
          code: "provider-failure",
          message:
            error instanceof Error ? error.message : "Failed to delete the ticket panel message.",
        };
      }
      try {
        await persistTicketPanelMutation(panel, null, actor);
      } catch (error) {
        return {
          ok: false,
          code: panel?.panelMessageId ? "partial-success" : "open-tickets",
          message: panel?.panelMessageId
            ? "The Discord panel was removed, but its saved configuration was not deleted. Retry deletion to reconcile it."
            : error instanceof Error
              ? error.message
              : "Failed to delete ticket panel.",
          ...(panel?.panelMessageId
            ? {
                recovery: {
                  operation: "delete" as const,
                  guildId: command.guildId,
                  panelId: command.panelId,
                  channelId: panel.panelChannelId,
                  messageId: panel.panelMessageId,
                },
              }
            : {}),
        };
      }
      return { ok: true, value: undefined };
    },

    async listPanelRevisions(input: {
      guildId: string;
      panelId: string;
      limit: number;
      beforeCreatedAtMs: number | null;
    }) {
      if (!options.configurationRevisions) {
        throw new Error("Configuration revision storage is unavailable.");
      }
      return options.configurationRevisions.list({
        guildId: input.guildId,
        feature: "tickets",
        resourceKey: input.panelId,
        limit: input.limit,
        beforeCreatedAtMs: input.beforeCreatedAtMs,
      });
    },

    async getPanelRevision(input: {
      guildId: string;
      revisionId: string;
    }): Promise<ConfigurationRevisionDetail | null> {
      if (!options.configurationRevisions) {
        throw new Error("Configuration revision storage is unavailable.");
      }
      const revision = await options.configurationRevisions.readById(input);
      if (!revision || revision.feature !== "tickets") return null;
      const previous = revision.previousRevisionId
        ? await options.configurationRevisions.readById({
            guildId: input.guildId,
            revisionId: revision.previousRevisionId,
          })
        : null;
      return {
        revision,
        diff: diffConfigurationSnapshots(
          previous?.snapshotJson ?? null,
          revision.snapshotJson,
          ticketPanelRevisionAdapter.display,
        ),
      };
    },

    async preparePanelRestore(input: {
      guildId: string;
      revisionId: string;
      resources: GuildTicketResources;
      signingSecret: string;
      nowMs?: number;
    }) {
      const prepared = await prepareRestoreState(input);
      const expiresAtMs = (input.nowMs ?? Date.now()) + 10 * 60 * 1_000;
      return {
        diff: diffConfigurationSnapshots(
          canonicalConfigurationJson(
            serializeTicketPanelConfiguration(prepared.currentPanel, prepared.resourceKey),
          ),
          canonicalConfigurationJson(prepared.targetSnapshot),
          ticketPanelRevisionAdapter.display,
        ),
        warnings: prepared.targetPanel
          ? ["Restoring configuration does not republish the Discord Ticket Panel."]
          : ["This restore deletes the saved Ticket Panel configuration."],
        requiredSecretInputs: [],
        followUpActions: prepared.targetPanel ? ["Publish or sync the Ticket Panel."] : [],
        previewToken: await signConfigurationRestoreToken(
          {
            version: 1,
            guildId: input.guildId,
            feature: "tickets",
            resourceKey: prepared.resourceKey,
            targetRevisionId: input.revisionId,
            currentHeadId: prepared.head.id,
            currentSnapshotHash: prepared.currentSnapshotHash,
            targetSnapshotHash: prepared.targetSnapshotHash,
            entitlementTier: prepared.entitlementTier,
            expiresAtMs,
            nonce: crypto.randomUUID(),
          },
          input.signingSecret,
        ),
        expiresAtMs,
        destructive: prepared.targetPanel === null,
      };
    },

    async restorePanelRevision(input: {
      guildId: string;
      revisionId: string;
      previewToken: string;
      resources: GuildTicketResources;
      signingSecret: string;
      actor: ConfigurationActorContext;
      nowMs?: number;
    }): Promise<TicketPanelResult<TicketPanelConfig | null>> {
      let token;
      try {
        token = await verifyConfigurationRestoreToken(
          input.previewToken,
          input.signingSecret,
          input.nowMs,
        );
      } catch (error) {
        return {
          ok: false,
          code: "invalid-panel",
          message:
            error instanceof Error && error.message === "restore_preview_expired"
              ? "The restore preview expired. Create a new preview."
              : "The restore preview is invalid. Create a new preview.",
        };
      }
      if (
        token.guildId !== input.guildId ||
        token.feature !== "tickets" ||
        token.targetRevisionId !== input.revisionId
      ) {
        return {
          ok: false,
          code: "invalid-panel",
          message: "The restore preview does not match this revision.",
        };
      }
      let prepared;
      try {
        prepared = await prepareRestoreState(input);
      } catch (error) {
        return {
          ok: false,
          code: "invalid-target",
          message: error instanceof Error ? error.message : "The revision cannot be restored.",
        };
      }
      if (
        token.resourceKey !== prepared.resourceKey ||
        token.currentHeadId !== prepared.head.id ||
        token.currentSnapshotHash !== prepared.currentSnapshotHash ||
        token.targetSnapshotHash !== prepared.targetSnapshotHash ||
        token.entitlementTier !== prepared.entitlementTier
      ) {
        return {
          ok: false,
          code: "invalid-panel",
          message:
            "Configuration, entitlement, or Discord resources changed. Create a new restore preview.",
        };
      }
      if (!prepared.targetPanel) {
        const count = await options.store.countOpenTicketsForPanel(
          input.guildId,
          prepared.resourceKey,
        );
        if (count > 0) {
          return {
            ok: false,
            code: "open-tickets",
            message: "Cannot restore deletion while this panel has open tickets.",
          };
        }
      }
      const actor = { ...input.actor, source: "restore" as const };
      await persistTicketPanelMutation(prepared.currentPanel, prepared.targetPanel, actor, {
        operation: "restore",
        restoredFromRevisionId: input.revisionId,
      });
      if (prepared.targetPanel) await options.discord.recordConfigChange(prepared.targetPanel);
      return { ok: true, value: prepared.targetPanel };
    },

    async resumeRecovery(
      recovery: TicketPanelRecovery,
    ): Promise<TicketPanelResult<TicketPanelConfig | undefined>> {
      try {
        if (recovery.operation === "delete") {
          const saved = await readPanel(recovery.guildId, recovery.panelId);
          if (!saved) return { ok: true, value: undefined };
          if (
            saved.panelChannelId !== recovery.channelId ||
            saved.panelMessageId !== recovery.messageId
          ) {
            return invalidRecovery();
          }
          const openTickets = await options.store.countOpenTicketsForPanel(
            recovery.guildId,
            recovery.panelId,
          );
          if (openTickets > 0) {
            return {
              ok: false,
              code: "open-tickets",
              message: "Cannot recover deletion while the panel has open tickets.",
            };
          }
          await options.store.deleteTicketPanelConfig(recovery.guildId, recovery.panelId);
          return { ok: true, value: undefined };
        }
        if (
          recovery.panel.guildId !== recovery.guildId ||
          recovery.panel.panelChannelId !== recovery.channelId ||
          recovery.panel.panelMessageId !==
            (recovery.operation === "publish" ? recovery.messageId : null)
        ) {
          return invalidRecovery();
        }
        const saved = await readPanel(recovery.guildId, recovery.panel.panelId ?? "main");
        if (saved && canonicalJson(saved) === canonicalJson(recovery.panel)) {
          return { ok: true, value: saved };
        }
        if (
          !saved ||
          saved.guildId !== recovery.guildId ||
          saved.panelId !== recovery.panel.panelId ||
          (recovery.operation === "publish"
            ? saved.panelMessageId !== null && saved.panelMessageId !== recovery.messageId
            : saved.panelMessageId !== recovery.messageId)
        ) {
          return invalidRecovery();
        }
        const enforced = await enforceMutation(recovery.panel);
        if (!enforced.ok) return enforced;
        if (recovery.operation === "publish") {
          requirePanelResources(enforced.value, await readGuildResources(enforced.value.guildId));
        }
        await options.store.upsertTicketPanelConfig(enforced.value);
        await options.discord.recordConfigChange(enforced.value);
        return { ok: true, value: enforced.value };
      } catch {
        return {
          ok: false,
          code: "partial-success",
          message: "Ticket panel recovery is still incomplete. Retry the recovery operation.",
          recovery,
        };
      }
    },
  };
}

function ticketSnapshotToPanel(
  guildId: string,
  snapshot: TicketPanelSnapshot,
  panelMessageId: string | null,
): TicketPanelConfig {
  return {
    guildId,
    panelId: snapshot.panelId,
    panelName: snapshot.panelName,
    panelChannelId: snapshot.panelChannelId,
    categoryChannelId: snapshot.categoryChannelId,
    transcriptChannelId: snapshot.transcriptChannelId,
    panelEmoji: snapshot.panelEmoji,
    panelTitle: snapshot.panelTitle,
    panelDescription: snapshot.panelDescription,
    panelFooter: snapshot.panelFooter,
    panelColor: snapshot.panelColor,
    panelMessageId,
    ticketCreationLimit: snapshot.ticketCreationLimit,
    ticketLimitRejectionMessage: snapshot.ticketLimitRejectionMessage,
    enableTicketClaiming: snapshot.enableTicketClaiming,
    aiTranscriptSummariesEnabled: snapshot.aiTranscriptSummariesEnabled,
    ticketTypes: snapshot.ticketTypes as TicketTypeConfig[],
  };
}

function invalidRecovery(): TicketPanelResult<never> {
  return {
    ok: false,
    code: "invalid-panel",
    message: "Ticket panel recovery no longer matches canonical saved state.",
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value) ?? "undefined";
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`;
}

function planLimit(message: string): TicketPanelResult<never> {
  return { ok: false, code: "plan-limit", message };
}

function succeeded(action: TicketTestAction, message: string): TicketTestActionResponse {
  return { ok: true, action, status: "success", message };
}

function skipped(action: TicketTestAction, message: string): TicketTestActionResponse {
  return { ok: false, action, status: "skipped", message };
}

function failed(action: TicketTestAction, message: string): TicketTestActionResponse {
  return { ok: false, action, status: "failed", message };
}

function createDraftPanel(
  guildId: string,
  existingPanels: TicketPanelConfig[],
  sourcePanel: TicketPanelConfig | null,
  createId: () => string,
): TicketPanelConfig {
  const panelId = createId();
  const panelName = nextPanelName(
    sourcePanel ? `${sourcePanel.panelName ?? "Main panel"} copy` : "New panel",
    existingPanels,
  );
  if (!sourcePanel) {
    return {
      guildId,
      panelId,
      panelName,
      panelChannelId: "",
      categoryChannelId: "",
      transcriptChannelId: "",
      panelEmoji: null,
      panelTitle: null,
      panelDescription: null,
      panelFooter: null,
      panelMessageId: null,
      ticketCreationLimit: null,
      ticketLimitRejectionMessage: null,
      enableTicketClaiming: false,
      aiTranscriptSummariesEnabled: false,
      ticketTypes: [],
    };
  }
  return {
    ...sourcePanel,
    guildId,
    panelId,
    panelName,
    panelChannelId: "",
    panelMessageId: null,
    ticketTypes: sourcePanel.ticketTypes.map((ticketType) => ({
      ...ticketType,
      participantManagementEnabled: ticketType.participantManagementEnabled ?? false,
    })),
  };
}

function nextPanelName(baseName: string, existingPanels: TicketPanelConfig[]): string {
  const used = new Set(existingPanels.map((panel) => panel.panelName ?? "Main panel"));
  if (!used.has(baseName)) return baseName;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${baseName} ${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

function preservePublication(
  panel: TicketPanelConfig,
  saved: TicketPanelConfig | null,
): TicketPanelConfig {
  return {
    ...panel,
    panelMessageId:
      saved && saved.panelChannelId === panel.panelChannelId ? saved.panelMessageId : null,
  };
}

function publishedPanelMoveFailure(
  candidate: TicketPanelConfig,
  saved: TicketPanelConfig | null,
): TicketPanelResult<never> | null {
  if (saved?.panelMessageId && saved.panelChannelId !== candidate.panelChannelId) {
    return {
      ok: false,
      code: "invalid-panel",
      message: "Unpublish this panel before changing its panel channel.",
    };
  }
  return null;
}

async function compensateFailedPublish(
  discord: TicketPanelDiscordAdapter,
  saved: TicketPanelConfig | null,
  guildId: string,
  publishedChannelId: string,
  publishedMessageId: string,
): Promise<boolean> {
  try {
    if (saved?.panelMessageId === publishedMessageId) {
      await discord.publish(saved, buildTicketPanelMessage(saved));
    } else {
      await discord.deleteMessage(guildId, publishedChannelId, publishedMessageId);
    }
    return true;
  } catch {
    return false;
  }
}

function applyFreePanelDefaults(panel: TicketPanelConfig): TicketPanelConfig {
  return {
    ...panel,
    ticketCreationLimit: 1,
    ticketLimitRejectionMessage: null,
    aiTranscriptSummariesEnabled: false,
    ticketTypes: panel.ticketTypes.map((ticketType) => ({
      ...ticketType,
      allowedCreatorRoleIds: [],
      responseRules: [],
      defaultTicketLinkPlatform: null,
      anonymousSupportEnabled: false,
      staffDiscussionThreadEnabled: false,
      ticketHistoryPromptVisibility: "off",
      limitExclusion: false,
    })),
  };
}

function findChangedPaidTicketControl(
  panel: TicketPanelConfig,
  saved: TicketPanelConfig | null,
): string | null {
  if (saved) {
    if (panel.ticketCreationLimit !== saved.ticketCreationLimit)
      return "Custom Ticket Creation Limit";
    if (panel.ticketLimitRejectionMessage !== saved.ticketLimitRejectionMessage)
      return "Custom limit rejection messages";
    if (Boolean(panel.aiTranscriptSummariesEnabled) !== Boolean(saved.aiTranscriptSummariesEnabled))
      return "AI Transcript Summary";
  } else {
    if (panel.ticketCreationLimit !== null && panel.ticketCreationLimit !== 1)
      return "Custom Ticket Creation Limit";
    if (panel.ticketLimitRejectionMessage !== null) return "Custom limit rejection messages";
    if (panel.aiTranscriptSummariesEnabled) return "AI Transcript Summary";
  }

  const savedTypes = new Map(saved?.ticketTypes.map((ticketType) => [ticketType.id, ticketType]));
  for (const [index, ticketType] of panel.ticketTypes.entries()) {
    const savedType = savedTypes.get(ticketType.id) ?? saved?.ticketTypes[index] ?? null;
    if (!sameStringArray(ticketType.allowedCreatorRoleIds, savedType?.allowedCreatorRoleIds))
      return "Creator role restrictions";
    if (
      JSON.stringify(ticketType.responseRules) !== JSON.stringify(savedType?.responseRules ?? []) ||
      (ticketType.defaultTicketLinkPlatform ?? null) !==
        (savedType?.defaultTicketLinkPlatform ?? null)
    )
      return "Ticket Response Rules";
    if (
      (ticketType.anonymousSupportEnabled ?? false) !==
      (savedType?.anonymousSupportEnabled ?? false)
    )
      return "Anonymous Support";
    if (
      (ticketType.staffDiscussionThreadEnabled ?? false) !==
        (savedType?.staffDiscussionThreadEnabled ?? false) ||
      (ticketType.ticketHistoryPromptVisibility ?? "off") !==
        (savedType?.ticketHistoryPromptVisibility ?? "off")
    )
      return "Staff Discussion Thread";
    if (ticketType.limitExclusion !== (savedType?.limitExclusion ?? false))
      return "Ticket Type Limit Exclusion";
  }
  return null;
}
function sameStringArray(left: string[] | undefined, right: string[] | undefined): boolean {
  return JSON.stringify(left ?? []) === JSON.stringify(right ?? []);
}

export function getMissingTicketPanelTargets(
  panel: TicketPanelConfig,
  resources: GuildTicketResources,
  paidAutomationAvailable = true,
): string[] {
  const categoryIds = new Set(resources.channels.filter((c) => c.type === 4).map((c) => c.id));
  const textChannelIds = new Set(
    resources.channels
      .filter((channel) => channel.type === 0 || channel.type === 5)
      .map((channel) => channel.id),
  );
  const roleIds = new Set(resources.roles.map((role) => role.id));
  const missing: string[] = [];
  if (!textChannelIds.has(panel.panelChannelId))
    missing.push(`panelChannelId ${panel.panelChannelId}`);
  if (!categoryIds.has(panel.categoryChannelId))
    missing.push(`categoryChannelId ${panel.categoryChannelId}`);
  if (!textChannelIds.has(panel.transcriptChannelId))
    missing.push(`transcriptChannelId ${panel.transcriptChannelId}`);
  panel.ticketTypes.forEach((ticketType, index) => {
    if (!roleIds.has(ticketType.supportRoleId))
      missing.push(`ticketTypes[${index}].supportRoleId ${ticketType.supportRoleId}`);
    if (paidAutomationAvailable) {
      for (const [roleIndex, roleId] of (ticketType.allowedCreatorRoleIds ?? []).entries()) {
        if (!roleIds.has(roleId))
          missing.push(`ticketTypes[${index}].allowedCreatorRoleIds[${roleIndex}] ${roleId}`);
      }
    }
  });
  return missing;
}

export function buildTicketPanelMessage(panel: TicketPanelConfig): TicketPanelMessage {
  const embed = buildTicketPanelEmbed(panel);
  return {
    content: embed ? "" : "Open a ticket by choosing the option that fits your request.",
    embeds: embed ? [embed] : [],
    components: chunkTicketTypeButtons(
      panel.ticketTypes.filter((type) => type.enabled !== false),
    ).map((row) => ({
      type: DISCORD_MESSAGE_COMPONENT_ROW,
      components: row.map((ticketType) => ({
        type: DISCORD_BUTTON_COMPONENT,
        custom_id: buildTicketOpenCustomId(ticketType.id, panel.panelId ?? "main"),
        label: ticketType.label,
        style: mapTicketButtonStyle(ticketType.buttonStyle),
        ...(ticketType.emoji ? { emoji: { name: ticketType.emoji } } : {}),
      })),
    })),
  };
}

function buildTicketPanelEmbed(
  panel: TicketPanelConfig,
): TicketPanelMessage["embeds"][number] | null {
  if (!panel.panelEmoji && !panel.panelTitle && !panel.panelDescription && !panel.panelFooter)
    return null;
  return {
    color: panel.panelColor ?? 0x57f287,
    ...(panel.panelTitle || panel.panelEmoji
      ? { title: formatTicketPanelEmbedTitle(panel.panelEmoji, panel.panelTitle) }
      : {}),
    ...(panel.panelDescription ? { description: panel.panelDescription } : {}),
    ...(panel.panelFooter ? { footer: { text: panel.panelFooter } } : {}),
  };
}

function formatTicketPanelEmbedTitle(panelEmoji: string | null, panelTitle: string | null): string {
  const emoji = panelEmoji?.trim();
  const title = panelTitle?.trim();
  return emoji && title ? `${emoji} ${title}` : emoji || title || "Tickets";
}

function chunkTicketTypeButtons(ticketTypes: TicketTypeConfig[]): TicketTypeConfig[][] {
  const rows: TicketTypeConfig[][] = [];
  for (let index = 0; index < ticketTypes.length; index += 5)
    rows.push(ticketTypes.slice(index, index + 5));
  return rows;
}

function mapTicketButtonStyle(style: TicketTypeConfig["buttonStyle"]): 1 | 2 | 3 | 4 {
  return style === "secondary" ? 2 : style === "success" ? 3 : style === "danger" ? 4 : 1;
}
