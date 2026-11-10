import {
  getGuildPermissionResources,
  type DiscordChannelResource,
  type DiscordGuildMemberResource,
  type DiscordRoleResource,
} from "../discord";
import type {
  LfgConfig,
  MarketplaceConfig,
  TicketPanelConfig,
  TimedRoleAssignment,
  MentionProtectionConfig,
  GuildAuditLogConfig,
  ManagedMessage,
  ManagedMessageDraft,
  MemberVerificationConfig,
  ImageRulesConfig,
  BotDefenseConfig,
  EventRecord,
  WebhookProxyConfig,
  BanCaseConfig,
  BanCaseSource,
} from "../types";
import type { EvidenceVaultConfig } from "../types";
import type { PlatformLinkConfig } from "./contracts/platform-link-store";
import type { AdminPermissionCheck } from "./admin-types";

const ADMINISTRATOR_PERMISSION = 1n << 3n;
const MANAGE_GUILD_PERMISSION = 1n << 5n;
const MANAGE_CHANNELS_PERMISSION = 1n << 4n;
const VIEW_CHANNEL_PERMISSION = 1n << 10n;
const SEND_MESSAGES_PERMISSION = 1n << 11n;
const MANAGE_MESSAGES_PERMISSION = 1n << 13n;
const ATTACH_FILES_PERMISSION = 1n << 15n;
const MANAGE_ROLES_PERMISSION = 1n << 28n;
const MANAGE_WEBHOOKS_PERMISSION = 1n << 29n;
const MANAGE_THREADS_PERMISSION = 1n << 34n;
const CREATE_PUBLIC_THREADS_PERMISSION = 1n << 35n;
const CREATE_PRIVATE_THREADS_PERMISSION = 1n << 36n;
const SEND_MESSAGES_IN_THREADS_PERMISSION = 1n << 38n;
const MODERATE_MEMBERS_PERMISSION = 1n << 40n;

export const DISCORD_PERMISSION_FLAGS = {
  administrator: ADMINISTRATOR_PERMISSION,
  manageGuild: MANAGE_GUILD_PERMISSION,
  manageChannels: MANAGE_CHANNELS_PERMISSION,
  viewChannel: VIEW_CHANNEL_PERMISSION,
  sendMessages: SEND_MESSAGES_PERMISSION,
  manageMessages: MANAGE_MESSAGES_PERMISSION,
  attachFiles: ATTACH_FILES_PERMISSION,
  manageRoles: MANAGE_ROLES_PERMISSION,
  manageWebhooks: MANAGE_WEBHOOKS_PERMISSION,
  manageThreads: MANAGE_THREADS_PERMISSION,
  createPublicThreads: CREATE_PUBLIC_THREADS_PERMISSION,
  createPrivateThreads: CREATE_PRIVATE_THREADS_PERMISSION,
  sendMessagesInThreads: SEND_MESSAGES_IN_THREADS_PERMISSION,
} as const;

export interface GuildPermissionContext {
  guildId: string;
  botUserId: string;
  channels: DiscordChannelResource[];
  roles: DiscordRoleResource[];
  member: DiscordGuildMemberResource;
}

export async function loadGuildPermissionContext(
  guildId: string,
  botUserId: string,
  botToken: string,
): Promise<GuildPermissionContext> {
  const resources = await getGuildPermissionResources(guildId, botUserId, botToken);

  return {
    guildId,
    botUserId,
    channels: resources.channels,
    roles: resources.roles,
    member: resources.member,
  };
}

export function buildBlocklistPermissionChecks(
  context: GuildPermissionContext,
): AdminPermissionCheck[] {
  const textChannels = context.channels.filter(
    (channel) => channel.type === 0 || channel.type === 5,
  );

  if (textChannels.length === 0) {
    return [
      {
        id: "blocklist-visible-text-channels",
        label: "Visible text channels",
        status: "warning",
        detail: "This server has no text channels to verify for reaction cleanup.",
      },
    ];
  }

  const visibleChannels = textChannels.filter((channel) =>
    hasPermission(getChannelPermissions(context, channel), VIEW_CHANNEL_PERMISSION),
  );
  const manageableChannels = visibleChannels.filter((channel) =>
    hasPermission(getChannelPermissions(context, channel), MANAGE_MESSAGES_PERMISSION),
  );

  return [
    {
      id: "blocklist-visible-text-channels",
      label: "Visible text channels",
      status: visibleChannels.length > 0 ? "ok" : "error",
      detail: `The bot can view ${visibleChannels.length} of ${textChannels.length} text channels in this server.`,
    },
    {
      id: "blocklist-manage-messages",
      label: "Manage Messages in text channels",
      status:
        visibleChannels.length > 0 && manageableChannels.length === visibleChannels.length
          ? "ok"
          : "warning",
      detail:
        visibleChannels.length === 0
          ? "Manage Messages cannot be verified until the bot can view at least one text channel."
          : manageableChannels.length === visibleChannels.length
            ? `Manage Messages is available in all ${visibleChannels.length} visible text channels.`
            : `Manage Messages is missing in ${visibleChannels.length - manageableChannels.length} of ${visibleChannels.length} visible text channels, so reaction cleanup can fail there.`,
    },
  ];
}

export function hasGuildManagerPermission(options: {
  guildId: string;
  roles: DiscordRoleResource[];
  memberRoleIds: readonly string[];
}): boolean {
  const permissions = getMemberBaseGuildPermissions({
    guildId: options.guildId,
    roles: options.roles,
    memberRoleIds: options.memberRoleIds,
  });
  return hasPermission(permissions, MANAGE_GUILD_PERMISSION);
}

export function buildTimedRolePermissionChecks(
  context: GuildPermissionContext,
  timedRoles: TimedRoleAssignment[],
): AdminPermissionCheck[] {
  const basePermissions = getBaseGuildPermissions(context);
  const highestRole = getHighestBotRole(context);

  const checks: AdminPermissionCheck[] = [
    {
      id: "timed-roles-manage-roles",
      label: "Manage Roles",
      status: hasPermission(basePermissions, MANAGE_ROLES_PERMISSION) ? "ok" : "error",
      detail: hasPermission(basePermissions, MANAGE_ROLES_PERMISSION)
        ? "Manage Roles is enabled for the bot at the server level."
        : "Manage Roles is missing for the bot at the server level.",
    },
  ];

  if (timedRoles.length === 0) {
    const manageableRoles = highestRole
      ? context.roles.filter(
          (role) => role.id !== context.guildId && role.position < highestRole.position,
        )
      : [];

    checks.push({
      id: "timed-roles-hierarchy-boundary",
      label: "Role hierarchy boundary",
      status: highestRole && manageableRoles.length > 0 ? "ok" : "warning",
      detail: highestRole
        ? `The bot's highest role is ${highestRole.name}; it can manage ${manageableRoles.length} role${manageableRoles.length === 1 ? "" : "s"} below it.`
        : "The bot has no server role above @everyone, so role hierarchy checks are limited.",
    });

    return checks;
  }

  const roleMap = new Map(context.roles.map((role) => [role.id, role] as const));
  const trackedTargetIds = [...new Set(timedRoles.map((assignment) => assignment.roleId))];
  const blockedTargets = trackedTargetIds.filter((roleId) => {
    const role = roleMap.get(roleId);
    if (!role || !highestRole) {
      return true;
    }
    return role.position >= highestRole.position;
  });

  checks.push({
    id: "timed-roles-target-hierarchy",
    label: "Timed role targets below the bot",
    status: blockedTargets.length === 0 ? "ok" : "error",
    detail:
      blockedTargets.length === 0
        ? `All ${trackedTargetIds.length} tracked timed role target${trackedTargetIds.length === 1 ? "" : "s"} are below the bot's highest role${highestRole ? ` (${highestRole.name})` : ""}.`
        : `${blockedTargets.length} tracked timed role${blockedTargets.length === 1 ? "" : "s"} ${blockedTargets.length === 1 ? "is" : "are"} at or above the bot's highest role.`,
  });

  return checks;
}

export function buildMentionProtectionPermissionChecks(
  context: GuildPermissionContext,
  config: MentionProtectionConfig | null,
  auditConfig: GuildAuditLogConfig | null,
  paidRestrictionsAvailable = true,
): AdminPermissionCheck[] {
  if (!config) return [];
  const basePermissions = getBaseGuildPermissions(context);
  const highestRole = getHighestBotRole(context);
  const selected = new Set(config.channelIds);
  const scopedChannels = context.channels.filter((channel) => {
    if (![0, 5, 15].includes(channel.type)) return false;
    if (selected.size === 0) return true;
    const matched = selected.has(channel.id);
    return config.channelMode === "include" ? matched : !matched;
  });
  const inaccessible = scopedChannels.filter((channel) => {
    const permissions = getChannelPermissions(context, channel);
    return (
      !hasPermission(permissions, VIEW_CHANNEL_PERMISSION) ||
      !hasPermission(permissions, SEND_MESSAGES_PERMISSION) ||
      !hasPermission(permissions, MANAGE_MESSAGES_PERMISSION)
    );
  });
  const responsePolicies = paidRestrictionsAvailable
    ? [
        config.adminInitialResponse,
        config.adminRepeatResponse,
        config.spamInitialResponse,
        config.spamRepeatResponse,
      ]
    : [];
  const timedRoleIds = responsePolicies
    .map((policy) => policy.restriction)
    .filter((restriction) => restriction.type === "timed-role")
    .map((restriction) => restriction.roleId);
  const roleMap = new Map(context.roles.map((role) => [role.id, role] as const));
  const blockedRoles = [...new Set(timedRoleIds)].filter((roleId) => {
    const role = roleMap.get(roleId);
    return !role || !highestRole || role.position >= highestRole.position;
  });
  const timeoutSelected = responsePolicies.some((policy) => policy.restriction.type === "timeout");

  return [
    {
      id: "mention-protection-channel-permissions",
      label: "In-scope channel permissions",
      status: inaccessible.length === 0 && scopedChannels.length > 0 ? "ok" : "error",
      detail:
        inaccessible.length === 0
          ? `The bot can view, reply, and delete messages in ${scopedChannels.length} in-scope channel${scopedChannels.length === 1 ? "" : "s"}.`
          : `${inaccessible.length} in-scope channel${inaccessible.length === 1 ? " is" : "s are"} missing View Channel, Send Messages, or Manage Messages.`,
    },
    {
      id: "mention-protection-timeout-members",
      label: "Timeout members",
      status:
        !timeoutSelected || hasPermission(basePermissions, MODERATE_MEMBERS_PERMISSION)
          ? "ok"
          : "error",
      detail: timeoutSelected
        ? hasPermission(basePermissions, MODERATE_MEMBERS_PERMISSION)
          ? "Moderate Members is available for configured Discord timeouts."
          : "Moderate Members is missing, so configured Discord timeouts will fail."
        : "No Response Policy currently selects a Discord timeout.",
    },
    {
      id: "mention-protection-timed-role-hierarchy",
      label: "Timed Role hierarchy",
      status:
        blockedRoles.length === 0 &&
        (!timedRoleIds.length || hasPermission(basePermissions, MANAGE_ROLES_PERMISSION))
          ? "ok"
          : "error",
      detail:
        timedRoleIds.length === 0
          ? "No Response Policy currently selects a Timed Role."
          : blockedRoles.length === 0 && hasPermission(basePermissions, MANAGE_ROLES_PERMISSION)
            ? "Every selected Timed Role is present and below the bot's highest role."
            : `${blockedRoles.length} selected Timed Role${blockedRoles.length === 1 ? " is" : "s are"} missing or above the bot, or Manage Roles is unavailable.`,
    },
    {
      id: "mention-protection-audit-destination",
      label: "Guild Audit Log destination",
      status: auditConfig?.auditChannelId ? "ok" : "warning",
      detail: auditConfig?.auditChannelId
        ? "A default Audit Destination is configured."
        : "No Audit Destination is configured. Deletion still works, but the event cannot be delivered to Discord.",
    },
  ];
}

export function buildTicketPermissionChecks(
  context: GuildPermissionContext,
  panel: TicketPanelConfig | null,
): AdminPermissionCheck[] {
  if (!panel) {
    return [];
  }

  const basePermissions = getBaseGuildPermissions(context);
  const roleMap = new Map(context.roles.map((role) => [role.id, role] as const));
  const channelMap = new Map(context.channels.map((channel) => [channel.id, channel] as const));
  const checks: AdminPermissionCheck[] = [
    {
      id: "tickets-manage-channels",
      label: "Manage Channels",
      status: hasPermission(basePermissions, MANAGE_CHANNELS_PERMISSION) ? "ok" : "error",
      detail: hasPermission(basePermissions, MANAGE_CHANNELS_PERMISSION)
        ? "Manage Channels is enabled for creating ticket channels."
        : "Manage Channels is missing, so new ticket channels cannot be created.",
    },
    buildConfiguredChannelCheck(
      context,
      channelMap,
      panel.panelChannelId,
      "Panel channel access",
      "tickets-panel-channel",
    ),
    buildConfiguredChannelCheck(
      context,
      channelMap,
      panel.transcriptChannelId,
      "Transcript channel access",
      "tickets-transcript-channel",
    ),
  ];

  if (panel.categoryChannelId) {
    const category = channelMap.get(panel.categoryChannelId);
    checks.push({
      id: "tickets-category-visibility",
      label: "Ticket category visibility",
      status:
        category && hasPermission(getChannelPermissions(context, category), VIEW_CHANNEL_PERMISSION)
          ? "ok"
          : "error",
      detail: !category
        ? "The configured ticket category no longer exists in Discord."
        : hasPermission(getChannelPermissions(context, category), VIEW_CHANNEL_PERMISSION)
          ? "The bot can view the configured ticket category."
          : "The bot cannot view the configured ticket category.",
    });
  }

  const supportRoleIds = [
    ...new Set(panel.ticketTypes.map((ticketType) => ticketType.supportRoleId).filter(Boolean)),
  ];
  const missingSupportRoles = supportRoleIds.filter((roleId) => !roleMap.has(roleId));
  checks.push({
    id: "tickets-support-roles",
    label: "Support roles",
    status: missingSupportRoles.length === 0 ? "ok" : "error",
    detail:
      missingSupportRoles.length === 0
        ? `All ${supportRoleIds.length} configured support role${supportRoleIds.length === 1 ? "" : "s"} are present in the server.`
        : `${missingSupportRoles.length} configured support role${missingSupportRoles.length === 1 ? "" : "s"} could not be found in Discord.`,
  });

  return checks;
}

export function buildMarketplacePermissionChecks(
  context: GuildPermissionContext,
  config: MarketplaceConfig | null,
): AdminPermissionCheck[] {
  if (!config) {
    return [];
  }

  const channelMap = new Map(context.channels.map((channel) => [channel.id, channel] as const));
  const checks: AdminPermissionCheck[] = [];

  if (config.noticeChannelId) {
    checks.push(
      buildConfiguredChannelCheck(
        context,
        channelMap,
        config.noticeChannelId,
        "Noticeboard channel access",
        "marketplace-noticeboard-channel",
      ),
    );
  }

  if (config.logChannelId) {
    checks.push(
      buildConfiguredChannelCheck(
        context,
        channelMap,
        config.logChannelId,
        "Marketplace log channel access",
        "marketplace-log-channel",
      ),
    );
  }

  return checks;
}

export function buildLfgPermissionChecks(
  context: GuildPermissionContext,
  config: LfgConfig | null,
): AdminPermissionCheck[] {
  if (!config) {
    return [];
  }

  const channelMap = new Map(context.channels.map((channel) => [channel.id, channel] as const));
  const checks: AdminPermissionCheck[] = [];

  if (config.noticeChannelId) {
    checks.push(
      buildConfiguredChannelCheck(
        context,
        channelMap,
        config.noticeChannelId,
        "LFG noticeboard channel access",
        "lfg-noticeboard-channel",
      ),
    );
  }

  if (config.approvalFlowEnabled) {
    const basePermissions = getBaseGuildPermissions(context);
    const category = config.approvalVoiceCategoryId
      ? channelMap.get(config.approvalVoiceCategoryId)
      : null;
    checks.push({
      id: "lfg-private-voice-category",
      label: "LFG private voice category",
      status:
        config.approvalVoiceCategoryId &&
        category?.type === 4 &&
        hasPermission(basePermissions, MANAGE_CHANNELS_PERMISSION)
          ? "ok"
          : "error",
      detail: !config.approvalVoiceCategoryId
        ? "Approval flow needs a Discord category for private voice rooms."
        : !category
          ? "The configured private voice category no longer exists in Discord."
          : category.type !== 4
            ? "The configured private voice target is not a Discord category."
            : hasPermission(basePermissions, MANAGE_CHANNELS_PERMISSION)
              ? "The bot can create private voice rooms in the configured category."
              : "Manage Channels is missing, so private voice rooms cannot be created.",
    });
  }

  if (config.approvalAuditChannelId) {
    checks.push(
      buildConfiguredChannelCheck(
        context,
        channelMap,
        config.approvalAuditChannelId,
        "LFG audit channel access",
        "lfg-audit-channel",
      ),
    );
  }

  return checks;
}

export function buildPlayerCountPermissionChecks(
  context: GuildPermissionContext,
  channelIds: string[],
): AdminPermissionCheck[] {
  const channelMap = new Map(context.channels.map((channel) => [channel.id, channel] as const));
  const checks: AdminPermissionCheck[] = [];

  for (const channelId of channelIds) {
    const channel = channelMap.get(channelId);
    if (!channel) {
      checks.push({
        id: `player-count-channel-${channelId}`,
        label: `Voice channel ${channelId}`,
        status: "error",
        detail: "The configured voice channel no longer exists.",
      });
      continue;
    }
    const permissions = getChannelPermissions(context, channel);
    const canManage = hasPermission(permissions, MANAGE_CHANNELS_PERMISSION);
    checks.push({
      id: `player-count-rename-channel-${channelId}`,
      label: `Rename voice channel "${channel.name}"`,
      status: canManage ? "ok" : "error",
      detail: canManage
        ? "The bot can rename this voice channel."
        : "The bot cannot rename this voice channel (Manage Channels permission required).",
    });
  }

  return checks;
}

export function buildServerLevelsPermissionChecks(
  context: GuildPermissionContext,
  announcementChannelId: string | null,
): AdminPermissionCheck[] {
  if (!announcementChannelId) return [];
  return [
    buildConfiguredChannelCheck(
      context,
      new Map(context.channels.map((channel) => [channel.id, channel] as const)),
      announcementChannelId,
      "Server Level announcement channel access",
      "server-levels-announcement-channel",
    ),
  ];
}

export function buildSteamLinkPermissionChecks(
  context: GuildPermissionContext,
  config: PlatformLinkConfig | null,
): AdminPermissionCheck[] {
  if (!config) {
    return [];
  }

  const checks: AdminPermissionCheck[] = [];
  const channelMap = new Map(context.channels.map((channel) => [channel.id, channel] as const));
  const basePermissions = getBaseGuildPermissions(context);
  const highestRole = getHighestBotRole(context);
  const roleMap = new Map(context.roles.map((role) => [role.id, role] as const));

  if (config.logChannelId) {
    checks.push(
      buildConfiguredChannelCheck(
        context,
        channelMap,
        config.logChannelId,
        "Steam link log channel access",
        "player-link-log-channel",
      ),
    );
  }

  if (config.linkedRoleId) {
    const role = roleMap.get(config.linkedRoleId);
    const canManageRole =
      hasPermission(basePermissions, MANAGE_ROLES_PERMISSION) &&
      Boolean(role && highestRole && role.position < highestRole.position);

    checks.push({
      id: "player-link-linked-role",
      label: "Steam linked role assignment",
      status: canManageRole ? "ok" : "error",
      detail: !role
        ? "The configured Steam linked role no longer exists in Discord."
        : !hasPermission(basePermissions, MANAGE_ROLES_PERMISSION)
          ? "Manage Roles is missing, so the bot cannot assign the configured Steam linked role."
          : !highestRole
            ? "The bot has no server role above @everyone, so it cannot manage the configured Steam linked role."
            : role.position >= highestRole.position
              ? `The configured Steam linked role is at or above the bot's highest role (${highestRole.name}).`
              : "The bot can assign the configured Steam linked role.",
    });
  }

  return checks;
}

export function buildEvidenceVaultPermissionChecks(
  context: GuildPermissionContext,
  config: EvidenceVaultConfig | null,
): AdminPermissionCheck[] {
  if (!config) {
    return [];
  }

  const channelMap = new Map(context.channels.map((channel) => [channel.id, channel] as const));
  const roleMap = new Map(context.roles.map((role) => [role.id, role] as const));
  const missingAccessRoleIds = config.accessRoleIds.filter((roleId) => !roleMap.has(roleId));
  return [
    buildConfiguredChannelCheck(
      context,
      channelMap,
      config.auditChannelId,
      "Evidence Vault audit channel access",
      "evidence-vault-audit-channel",
    ),
    {
      id: "evidence-vault-access-roles",
      label: "Evidence Vault access roles",
      status: missingAccessRoleIds.length === 0 ? "ok" : "error",
      detail:
        missingAccessRoleIds.length === 0
          ? `All ${config.accessRoleIds.length} configured Evidence Vault access role${config.accessRoleIds.length === 1 ? "" : "s"} are present in Discord.`
          : `${missingAccessRoleIds.length} configured Evidence Vault access role${missingAccessRoleIds.length === 1 ? "" : "s"} could not be found in Discord.`,
    },
  ];
}

export function buildManagedMessagePermissionChecks(
  context: GuildPermissionContext,
  messages: ManagedMessage[],
  drafts: ManagedMessageDraft[],
): AdminPermissionCheck[] {
  const channelIds = [
    ...new Set([...messages, ...drafts].map((entry) => entry.channelId).filter(Boolean)),
  ];
  return buildMessageChannelChecks(context, channelIds, "Managed Message destination");
}

export function buildMemberVerificationPermissionChecks(
  context: GuildPermissionContext,
  config: MemberVerificationConfig | null,
): AdminPermissionCheck[] {
  if (!config) return [];
  const checks = buildRoleAssignmentChecks(context, config.verifiedRoleId, "Verified Role");
  if (config.deliveryMode === "channel" && config.welcomeChannelId) {
    checks.push(
      ...buildMessageChannelChecks(context, [config.welcomeChannelId], "Welcome Panel channel"),
    );
  }
  return checks;
}

export function buildImageRulesPermissionChecks(
  context: GuildPermissionContext,
  config: ImageRulesConfig | null,
): AdminPermissionCheck[] {
  if (!config) return [];
  const targetChecks = buildMessageChannelChecks(
    context,
    config.targetChannelIds,
    "Image Rules target",
    true,
  );
  const queueChecks = config.modQueueChannelId
    ? buildMessageChannelChecks(context, [config.modQueueChannelId], "Image Rules Mod Queue")
    : [];
  return [...targetChecks, ...queueChecks];
}

export function buildBotDefensePermissionChecks(
  context: GuildPermissionContext,
  config: BotDefenseConfig | null,
): AdminPermissionCheck[] {
  if (!config) return [];
  const checks = config.honeypotEnabled
    ? buildMessageChannelChecks(
        context,
        config.honeypotChannelIds,
        "Honeypot Channel",
        config.honeypotDeleteMessage,
      )
    : [];
  if (config.modQueueChannelId) {
    checks.push(
      ...buildMessageChannelChecks(context, [config.modQueueChannelId], "Bot Defense Mod Queue"),
    );
  }
  if (config.rateEnabled && config.rateDeleteMessage) {
    const visibleMessageChannels = context.channels
      .filter((channel) => [0, 5, 15].includes(channel.type))
      .map((channel) => channel.id);
    checks.push(
      ...buildMessageChannelChecks(context, visibleMessageChannels, "Rate Detector scope", true),
    );
  }
  return checks;
}

export function buildEventPermissionChecks(
  context: GuildPermissionContext,
  events: EventRecord[],
  paidFeaturesAvailable = true,
): AdminPermissionCheck[] {
  if (events.length === 0) return [];
  const channelMap = new Map(context.channels.map((channel) => [channel.id, channel] as const));
  const checks: AdminPermissionCheck[] = [];
  if (!paidFeaturesAvailable) {
    checks.push({
      id: "events-paid-feature-availability",
      label: "Events availability",
      status: "warning",
      detail: "Events is dormant while this Guild uses the Free plan.",
      remediation: "Assign paid access to this Guild before publishing or updating Events.",
    });
  }
  const byChannel = new Map<string, EventRecord[]>();
  for (const event of events) {
    const grouped = byChannel.get(event.channelId) ?? [];
    grouped.push(event);
    byChannel.set(event.channelId, grouped);
  }

  for (const [channelId, channelEvents] of byChannel) {
    checks.push(
      buildConfiguredChannelCheck(context, channelMap, channelId, "Event publish channel access"),
    );
    if (!channelEvents.some((event) => event.threadEnabled)) continue;
    const channel = channelMap.get(channelId);
    const permissions = channel ? getChannelPermissions(context, channel) : 0n;
    const missing = [
      !hasPermission(permissions, CREATE_PUBLIC_THREADS_PERMISSION) && "Create Public Threads",
      !hasPermission(permissions, SEND_MESSAGES_IN_THREADS_PERMISSION) &&
        "Send Messages in Threads",
    ].filter(Boolean);
    checks.push({
      id: `events-thread-channel-${channelId}`,
      label: `Event thread access${channel ? `: ${channel.name}` : ""}`,
      status: missing.length === 0 ? "ok" : "error",
      detail:
        missing.length === 0
          ? "The bot can create and post in Event threads."
          : `Missing ${missing.join(", ")} for Events with threads enabled.`,
    });
  }
  return checks;
}

export function buildGuildAuditLogPermissionChecks(
  context: GuildPermissionContext,
  config: GuildAuditLogConfig | null,
): AdminPermissionCheck[] {
  if (!config?.auditChannelId) return [];
  const channelMap = new Map(context.channels.map((channel) => [channel.id, channel] as const));
  return [
    buildConfiguredChannelCheck(
      context,
      channelMap,
      config.auditChannelId,
      "Guild Audit Log destination",
      "guild-audit-log-destination",
    ),
  ];
}

export function buildWebhookPermissionChecks(
  configs: WebhookProxyConfig[],
  paidFeaturesAvailable = true,
): AdminPermissionCheck[] {
  if (configs.length === 0) return [];
  return configs.map((config) => {
    const destinationIds = new Set(config.destinations.map((destination) => destination.id));
    const invalidDestinations = config.destinations.filter((destination) => {
      try {
        const url = new URL(destination.url);
        return url.protocol !== "https:" && url.protocol !== "http:";
      } catch {
        return true;
      }
    });
    const missingReferences = [
      ...config.defaultDestinationIds,
      ...config.routingRules.flatMap((rule) => rule.destinationIds),
    ].filter((destinationId) => !destinationIds.has(destinationId));
    const invalidPatterns = [
      ...config.routingRules.map((rule) => [rule.pattern, rule.flags] as const),
      ...(config.contentReplacements ?? []).map(
        (replacement) => [replacement.pattern, replacement.flags] as const,
      ),
    ].filter(([pattern, flags]) => {
      try {
        new RegExp(pattern, flags);
        return false;
      } catch {
        return true;
      }
    });
    const ready =
      config.destinations.length > 0 &&
      invalidDestinations.length === 0 &&
      missingReferences.length === 0 &&
      invalidPatterns.length === 0;
    const status = !ready ? "error" : !paidFeaturesAvailable || !config.enabled ? "warning" : "ok";
    return {
      id: `webhook-configuration-${config.publicId}`,
      label: `Webhook configuration: ${config.name}`,
      status,
      detail: !ready
        ? `${[
            config.destinations.length === 0 && "no destinations",
            invalidDestinations.length > 0 &&
              `${invalidDestinations.length} invalid destination URL(s)`,
            missingReferences.length > 0 &&
              `${missingReferences.length} missing destination reference(s)`,
            invalidPatterns.length > 0 && `${invalidPatterns.length} invalid regex pattern(s)`,
          ]
            .filter(Boolean)
            .join(", ")}.`
        : !paidFeaturesAvailable
          ? "This Webhook Proxy configuration is dormant while the Guild uses the Free plan."
          : !config.enabled
            ? "This Webhook Proxy configuration is saved but disabled."
            : "Destinations, routing references, and regex patterns are valid. No destination request was made.",
      ...(!paidFeaturesAvailable
        ? { remediation: "Assign paid access to this Guild before enabling webhook delivery." }
        : !config.enabled
          ? { remediation: "Enable and save this Webhook Proxy configuration when it is ready." }
          : {}),
    };
  });
}

export function buildBanCasePermissionChecks(
  context: GuildPermissionContext,
  config: BanCaseConfig | null,
  sources: BanCaseSource[],
  paidFeaturesAvailable = true,
): AdminPermissionCheck[] {
  const checks: AdminPermissionCheck[] = [];
  if (!config) return checks;
  checks.push({
    id: "ban-cases-availability",
    label: "Ban Cases availability",
    status: !paidFeaturesAvailable || !config.enabled ? "warning" : "ok",
    detail: !paidFeaturesAvailable
      ? "Ban Cases is dormant while this Guild uses the Free plan."
      : config.enabled
        ? "Ban Cases is enabled."
        : "Ban Cases is saved but disabled.",
    ...(!paidFeaturesAvailable
      ? { remediation: "Assign paid access to this Guild before enabling Ban Cases." }
      : !config.enabled
        ? { remediation: "Enable and save Ban Cases when the configuration is ready." }
        : {}),
  });
  if (!config.forumChannelId) {
    checks.push({
      id: "ban-cases-forum-access",
      label: "Ban Case forum access",
      status: "error",
      detail: "No Ban Case Forum is configured.",
      remediation: "Select and save a staff-scoped Discord Forum channel.",
    });
    return checks;
  }
  const forum = context.channels.find((channel) => channel.id === config.forumChannelId);
  const permissions = forum ? getChannelPermissions(context, forum) : 0n;
  const missing = [
    !hasPermission(permissions, VIEW_CHANNEL_PERMISSION) && "View Channel",
    !hasPermission(permissions, SEND_MESSAGES_PERMISSION) && "Send Messages",
    !hasPermission(permissions, CREATE_PUBLIC_THREADS_PERMISSION) && "Create Public Threads",
    !hasPermission(permissions, SEND_MESSAGES_IN_THREADS_PERMISSION) && "Send Messages in Threads",
    !hasPermission(permissions, MANAGE_THREADS_PERMISSION) && "Manage Threads",
  ].filter(Boolean);
  checks.push({
    id: "ban-cases-forum-access",
    label: "Ban Case forum access",
    status: forum?.type === 15 && missing.length === 0 ? "ok" : "error",
    detail: !forum
      ? "The configured Ban Case forum no longer exists in Discord."
      : forum.type !== 15
        ? "The configured Ban Case destination is not a Discord forum."
        : missing.length === 0
          ? "The bot can create, post in, and update Ban Case forum threads."
          : `Missing ${missing.join(", ")} in the configured Ban Case forum.`,
  });
  checks.push({
    id: "ban-cases-enabled-sources",
    label: "Enabled Ban Case sources",
    status: sources.some((source) => source.enabled) ? "ok" : "warning",
    detail: sources.some((source) => source.enabled)
      ? `${sources.filter((source) => source.enabled).length} Ban Case source(s) are enabled.`
      : "No Ban Case source is enabled.",
    ...(sources.some((source) => source.enabled)
      ? {}
      : { remediation: "Enable at least one saved Ban Case Source." }),
  });
  return checks;
}

function buildRoleAssignmentChecks(
  context: GuildPermissionContext,
  roleId: string | null,
  label: string,
): AdminPermissionCheck[] {
  const basePermissions = getBaseGuildPermissions(context);
  const role = roleId ? context.roles.find((candidate) => candidate.id === roleId) : null;
  const highestRole = getHighestBotRole(context);
  const hasManageRoles = hasPermission(basePermissions, MANAGE_ROLES_PERMISSION);
  const hierarchyReady = Boolean(role && highestRole && role.position < highestRole.position);
  return [
    {
      id: "role-assignment-manage-roles",
      label: "Manage Roles",
      status: hasManageRoles ? "ok" : "error",
      detail: hasManageRoles
        ? "Manage Roles is enabled for the bot."
        : "Manage Roles is missing for the bot.",
    },
    {
      id: `role-assignment-${permissionCheckId(label)}-hierarchy`,
      label: `${label} hierarchy`,
      status: !roleId ? "warning" : hierarchyReady ? "ok" : "error",
      detail: !roleId
        ? `${label} is not configured yet.`
        : hierarchyReady
          ? `${label} is below the bot's highest role.`
          : `${label} is missing or is not below the bot's highest role.`,
    },
  ];
}

function buildMessageChannelChecks(
  context: GuildPermissionContext,
  channelIds: string[],
  label: string,
  requireManageMessages = false,
): AdminPermissionCheck[] {
  const channelMap = new Map(context.channels.map((channel) => [channel.id, channel] as const));
  return [...new Set(channelIds)].map((channelId) => {
    const channel = channelMap.get(channelId);
    if (!channel) {
      return {
        id: `message-channel-${permissionCheckId(label)}-${channelId}`,
        label,
        status: "error",
        detail: "The configured Discord channel no longer exists.",
      };
    }
    const permissions = getChannelPermissions(context, channel);
    const canView = hasPermission(permissions, VIEW_CHANNEL_PERMISSION);
    const canSend = hasPermission(permissions, SEND_MESSAGES_PERMISSION);
    const canManage =
      !requireManageMessages || hasPermission(permissions, MANAGE_MESSAGES_PERMISSION);
    const ready = canView && canSend && canManage;
    return {
      id: `message-channel-${permissionCheckId(label)}-${channelId}`,
      label: `${label}: ${channel.name}`,
      status: ready ? "ok" : "error",
      detail: ready
        ? `The bot has the required permissions in #${channel.name}.`
        : `Missing ${[
            !canView && "View Channel",
            !canSend && "Send Messages",
            !canManage && "Manage Messages",
          ]
            .filter(Boolean)
            .join(", ")} in #${channel.name}.`,
    };
  });
}

function buildConfiguredChannelCheck(
  context: GuildPermissionContext,
  channelMap: Map<string, DiscordChannelResource>,
  channelId: string,
  label: string,
  id = `configured-channel-${permissionCheckId(label)}-${channelId}`,
): AdminPermissionCheck {
  const channel = channelMap.get(channelId);
  if (!channel) {
    return {
      id,
      label,
      status: "error",
      detail: "The configured Discord channel no longer exists.",
    };
  }

  const permissions = getChannelPermissions(context, channel);
  const hasChannelAccess =
    hasPermission(permissions, VIEW_CHANNEL_PERMISSION) &&
    hasPermission(permissions, SEND_MESSAGES_PERMISSION);

  return {
    id,
    label,
    status: hasChannelAccess ? "ok" : "error",
    detail: hasChannelAccess
      ? "The bot can view and send messages in the configured channel."
      : "The bot cannot fully access the configured channel.",
  };
}

function permissionCheckId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

export function getBaseGuildPermissions(context: GuildPermissionContext): bigint {
  return getMemberBaseGuildPermissions({
    guildId: context.guildId,
    roles: context.roles,
    memberRoleIds: context.member.roles,
  });
}

export function getMemberBaseGuildPermissions(options: {
  guildId: string;
  roles: DiscordRoleResource[];
  memberRoleIds: readonly string[];
}): bigint {
  const roleMap = new Map(options.roles.map((role) => [role.id, role] as const));
  let permissions = parsePermissionBits(roleMap.get(options.guildId)?.permissions);

  for (const roleId of options.memberRoleIds) {
    permissions |= parsePermissionBits(roleMap.get(roleId)?.permissions);
  }

  return permissions;
}

export function getChannelPermissions(
  context: GuildPermissionContext,
  channel: DiscordChannelResource,
): bigint {
  let permissions = getBaseGuildPermissions(context);
  if ((permissions & ADMINISTRATOR_PERMISSION) !== 0n) {
    return permissions;
  }

  const overwrites = channel.permission_overwrites ?? [];
  const everyoneOverwrite = overwrites.find((overwrite) => overwrite.id === context.guildId);
  if (everyoneOverwrite) {
    permissions = applyOverwrite(permissions, everyoneOverwrite.allow, everyoneOverwrite.deny);
  }

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites) {
    if (overwrite.type !== 0 || !context.member.roles.includes(overwrite.id)) {
      continue;
    }
    roleAllow |= parsePermissionBits(overwrite.allow);
    roleDeny |= parsePermissionBits(overwrite.deny);
  }
  permissions &= ~roleDeny;
  permissions |= roleAllow;

  const memberOverwrite = overwrites.find(
    (overwrite) => overwrite.type === 1 && overwrite.id === context.botUserId,
  );
  if (memberOverwrite) {
    permissions = applyOverwrite(permissions, memberOverwrite.allow, memberOverwrite.deny);
  }

  return permissions;
}

export function getHighestBotRole(context: GuildPermissionContext): DiscordRoleResource | null {
  const roleMap = new Map(context.roles.map((role) => [role.id, role] as const));
  let highestRole: DiscordRoleResource | null = null;

  for (const roleId of context.member.roles) {
    const role = roleMap.get(roleId);
    if (!role) {
      continue;
    }
    if (!highestRole || role.position > highestRole.position) {
      highestRole = role;
    }
  }

  return highestRole;
}

export function hasPermission(permissions: bigint, flag: bigint): boolean {
  return (permissions & ADMINISTRATOR_PERMISSION) !== 0n || (permissions & flag) === flag;
}

function applyOverwrite(permissions: bigint, allow: string, deny: string): bigint {
  const denied = parsePermissionBits(deny);
  const allowed = parsePermissionBits(allow);
  return (permissions & ~denied) | allowed;
}

function parsePermissionBits(value: string | undefined): bigint {
  if (!value) {
    return 0n;
  }

  try {
    return BigInt(value);
  } catch {
    return 0n;
  }
}
