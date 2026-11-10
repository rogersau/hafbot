import type { DiscordChannelResource } from "../../discord";
import type {
  TicketSetupCheck,
  TicketSetupCheckResponse,
  TicketSetupCheckStatus,
} from "../../runtime/admin-types";
import {
  DISCORD_PERMISSION_FLAGS,
  getBaseGuildPermissions,
  getChannelPermissions,
  hasPermission,
  type GuildPermissionContext,
} from "../../runtime/admin-permissions";
import type { TicketPanelConfig, TicketTypeConfig } from "../../types";

export interface TicketPanelDiagnosticsInput {
  guildId: string;
  panel: TicketPanelConfig | null;
  context: GuildPermissionContext;
  isPremiumGuild: boolean;
  aiSummariesAvailable: boolean;
}

export function buildTicketPanelDiagnostics(
  input: TicketPanelDiagnosticsInput,
): TicketSetupCheckResponse {
  const checks = buildTicketSetupChecks(input);
  return {
    guildId: input.guildId,
    panelId: input.panel?.panelId ?? null,
    overallStatus: summarizeSetupStatus(checks),
    checks,
    testActions: buildTicketTestActions(input.panel),
  };
}

function buildTicketSetupChecks(input: TicketPanelDiagnosticsInput): TicketSetupCheck[] {
  const { panel, context } = input;
  if (!panel) {
    return [
      {
        id: "panel",
        label: "Ticket panel",
        status: "error",
        detail: "Create and save a ticket panel before members can open tickets.",
      },
    ];
  }
  const channelMap = new Map(context.channels.map((channel) => [channel.id, channel] as const));
  const roleMap = new Map(context.roles.map((role) => [role.id, role] as const));
  const basePermissions = getBaseGuildPermissions(context);
  const staffThreadsEnabled = panel.ticketTypes.some(
    (ticketType) =>
      (ticketType.anonymousSupportEnabled ?? ticketType.anonymousEnabled ?? false) ||
      (ticketType.staffDiscussionThreadEnabled ?? ticketType.anonymousEnabled ?? false),
  );
  return [
    {
      id: "ticket-types",
      label: "Ticket types",
      status: panel.ticketTypes.length > 0 ? "ok" : "error",
      detail:
        panel.ticketTypes.length > 0
          ? `${panel.ticketTypes.length} ticket type${panel.ticketTypes.length === 1 ? "" : "s"} can be opened from this panel.`
          : "Add at least one ticket type before publishing this panel.",
    },
    buildTicketChannelSetupCheck(
      context,
      channelMap,
      panel.panelChannelId,
      "panel-channel",
      "Panel channel",
      "Bot can post ticket panel",
      ["view", "send"],
    ),
    buildTicketCategorySetupCheck(
      context,
      channelMap,
      panel.categoryChannelId,
      basePermissions,
      staffThreadsEnabled,
    ),
    buildTicketChannelSetupCheck(
      context,
      channelMap,
      panel.transcriptChannelId,
      "transcript-channel",
      "Transcript channel",
      "Bot can upload transcript messages",
      ["view", "send", "attach"],
    ),
    buildSupportRolesSetupCheck(roleMap, panel.ticketTypes),
    buildAiSummarySetupCheck(panel, input.isPremiumGuild, input.aiSummariesAvailable),
  ];
}

function buildTicketChannelSetupCheck(
  context: GuildPermissionContext,
  channelMap: Map<string, DiscordChannelResource>,
  channelId: string,
  id: string,
  label: string,
  okDetail: string,
  required: Array<"view" | "send" | "attach">,
): TicketSetupCheck {
  if (!channelId) {
    return {
      id,
      label,
      status: "error",
      detail: `Choose a ${label.toLowerCase()} before testing this setup.`,
    };
  }
  const channel = channelMap.get(channelId);
  if (!channel) {
    return { id, label, status: "error", detail: "The selected Discord channel no longer exists." };
  }
  const permissions = getChannelPermissions(context, channel);
  const missing = required.filter((permission) => {
    if (permission === "view")
      return !hasPermission(permissions, DISCORD_PERMISSION_FLAGS.viewChannel);
    if (permission === "send")
      return !hasPermission(permissions, DISCORD_PERMISSION_FLAGS.sendMessages);
    return !hasPermission(permissions, DISCORD_PERMISSION_FLAGS.attachFiles);
  });
  return {
    id,
    label,
    status: missing.length === 0 ? "ok" : "error",
    detail:
      missing.length === 0
        ? `${okDetail} in #${channel.name}.`
        : `The bot is missing ${formatMissingTicketPermissions(missing)} in #${channel.name}.`,
  };
}

function buildTicketCategorySetupCheck(
  context: GuildPermissionContext,
  channelMap: Map<string, DiscordChannelResource>,
  categoryChannelId: string,
  basePermissions: bigint,
  staffThreadsEnabled: boolean,
): TicketSetupCheck {
  const label = "Ticket category";
  if (!categoryChannelId) {
    return {
      id: "ticket-category",
      label,
      status: "error",
      detail: "Choose a Discord category where private ticket channels should be created.",
    };
  }
  const category = channelMap.get(categoryChannelId);
  if (!category) {
    return {
      id: "ticket-category",
      label,
      status: "error",
      detail: "The selected ticket category no longer exists.",
    };
  }
  if (category.type !== 4) {
    return {
      id: "ticket-category",
      label,
      status: "error",
      detail: "The selected ticket target is not a Discord category.",
    };
  }
  const permissions = getChannelPermissions(context, category);
  const canView = hasPermission(permissions, DISCORD_PERMISSION_FLAGS.viewChannel);
  const canManageChannels = hasPermission(basePermissions, DISCORD_PERMISSION_FLAGS.manageChannels);
  const missingThreadPermissions = staffThreadsEnabled
    ? [
        !hasPermission(permissions, DISCORD_PERMISSION_FLAGS.createPrivateThreads) &&
          "Create Private Threads",
        !hasPermission(permissions, DISCORD_PERMISSION_FLAGS.sendMessagesInThreads) &&
          "Send Messages in Threads",
      ].filter((permission): permission is string => Boolean(permission))
    : [];
  return {
    id: "ticket-category",
    label,
    status: canView && canManageChannels && missingThreadPermissions.length === 0 ? "ok" : "error",
    detail:
      canView && canManageChannels && missingThreadPermissions.length === 0
        ? `Bot can create private ticket channels under ${category.name}.`
        : !canManageChannels
          ? "The bot is missing Manage Channels, so it cannot create ticket channels."
          : !canView
            ? `The bot cannot view the ${category.name} category.`
            : `The bot is missing ${missingThreadPermissions.join(
                " and ",
              )} in the ${category.name} category.`,
  };
}

function buildSupportRolesSetupCheck(
  roleMap: Map<string, { id: string; name: string }>,
  ticketTypes: TicketTypeConfig[],
): TicketSetupCheck {
  const unconfiguredCount = ticketTypes.filter((ticketType) => !ticketType.supportRoleId).length;
  if (unconfiguredCount > 0) {
    return {
      id: "support-roles",
      label: "Support roles",
      status: "error",
      detail: `${unconfiguredCount} ticket type${unconfiguredCount === 1 ? " is" : "s are"} missing a support role.`,
    };
  }
  const supportRoleIds = [
    ...new Set(ticketTypes.map((ticketType) => ticketType.supportRoleId).filter(Boolean)),
  ];
  if (supportRoleIds.length === 0) {
    return {
      id: "support-roles",
      label: "Support roles",
      status: "error",
      detail: "Each ticket type needs a support role.",
    };
  }
  const missing = supportRoleIds.filter((roleId) => !roleMap.has(roleId));
  return {
    id: "support-roles",
    label: "Support roles",
    status: missing.length === 0 ? "ok" : "error",
    detail:
      missing.length === 0
        ? `All ${supportRoleIds.length} selected support role${supportRoleIds.length === 1 ? "" : "s"} still exist in Discord.`
        : `${missing.length} selected support role${missing.length === 1 ? "" : "s"} no longer exist in Discord.`,
  };
}

function buildAiSummarySetupCheck(
  panel: TicketPanelConfig,
  isPremiumGuild: boolean,
  aiSummariesAvailable: boolean,
): TicketSetupCheck {
  if (!panel.aiTranscriptSummariesEnabled) {
    return {
      id: "ai-summaries",
      label: "AI summaries",
      status: "ok",
      detail: isPremiumGuild
        ? "AI summaries are available for this server and currently turned off for this panel."
        : "AI summaries require Premium and are currently turned off for this panel.",
    };
  }
  if (!isPremiumGuild) {
    return {
      id: "ai-summaries",
      label: "AI summaries",
      status: "warning",
      detail: "AI summaries are enabled, but this server needs Premium before summaries can run.",
    };
  }
  return {
    id: "ai-summaries",
    label: "AI summaries",
    status: aiSummariesAvailable ? "ok" : "warning",
    detail: aiSummariesAvailable
      ? "AI summaries are enabled and available for new closed tickets."
      : "AI summaries are enabled, but the service is currently unavailable. Ticket transcripts will still be created.",
  };
}

function summarizeSetupStatus(checks: TicketSetupCheck[]): TicketSetupCheckStatus {
  if (checks.some((check) => check.status === "error")) return "error";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

function buildTicketTestActions(
  panel: TicketPanelConfig | null,
): TicketSetupCheckResponse["testActions"] {
  const hasPanel = Boolean(panel);
  return [
    {
      action: "panel-post",
      label: "Test panel channel",
      enabled: hasPanel && Boolean(panel?.panelChannelId),
      reason: !hasPanel
        ? "Save a ticket panel first."
        : panel?.panelChannelId
          ? null
          : "Choose a panel channel first.",
    },
    {
      action: "transcript-upload",
      label: "Test transcript upload",
      enabled: hasPanel && Boolean(panel?.transcriptChannelId),
      reason: !hasPanel
        ? "Save a ticket panel first."
        : panel?.transcriptChannelId
          ? null
          : "Choose a transcript channel first.",
    },
    {
      action: "ai-summary",
      label: "Test AI summary",
      enabled: hasPanel && Boolean(panel?.aiTranscriptSummariesEnabled),
      reason: !hasPanel
        ? "Save a ticket panel first."
        : panel?.aiTranscriptSummariesEnabled
          ? null
          : "Turn on AI transcript summaries first.",
    },
  ];
}

function formatMissingTicketPermissions(missing: Array<"view" | "send" | "attach">): string {
  return missing
    .map((permission) =>
      permission === "view"
        ? "View Channel"
        : permission === "send"
          ? "Send Messages"
          : "Attach Files",
    )
    .join(", ");
}
