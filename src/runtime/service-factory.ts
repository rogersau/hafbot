import type { QueueProducer } from "./queue-types";
import type { OperationalIncidentStore as BanIncidentStore } from "../operations/incidents";
import { createBanCaseEnforcementRuntime } from "./ban-case-enforcement-runtime";
import type { BanCaseEnforcement } from "../ban-case-enforcement/service";
import type { EnforcementStore } from "../ban-case-enforcement/store";
import type { WardogsService } from "../wardogs/service";
import { createWardogsPlayerCountStatusProvider } from "../services/wardogs-player-count-status-provider";
import { addGuildMemberRole, createChannelMessage, removeGuildMemberRole } from "../discord";
import {
  createForumThread,
  createMessageThread,
  modifyThread,
  removeThreadMember,
} from "../discord/threads";
import {
  addThreadMember,
  createLfgPrivateVoiceChannel,
  modifyChannel,
  updateLfgPrivateVoiceChannelAccess,
} from "../discord/channels";
import {
  createUserDmMessage,
  deleteChannel,
  deleteChannelMessage,
  editChannelMessage,
} from "../discord/messages";
import { fetchGuildSummary, getGuildPermissionResources, listGuildRoles } from "../discord/guilds";
import {
  createDiscordGuildResourceValidator,
  type GuildResourceValidator,
} from "../discord/guild-resource-validator";
import { fetchGuildMember, guildMemberHasRole } from "../discord/members";
import { BlocklistService } from "../services/blocklist-service";
import { LfgService } from "../services/lfg-service";
import { EventsService } from "../services/events-service";
import {
  EventTeamDeliveryService,
  type EventTeamDeliveryStore,
} from "../services/event-team-delivery-service";
import { MarketplaceService } from "../services/marketplace-service";
import {
  PlayerCountService,
  type PlayerCountStreakReportedStore,
} from "../services/player-count-service";
import { createPlayerCountStatusProviderResolver } from "../services/player-count-status-provider";
import { createSteamWebPlayerCountStatusProvider } from "../services/steam-web-player-count-status-provider";
import {
  createPlatformLinkService,
  type PlatformLinkService,
} from "../services/platform-link-service";
import {
  createPlatformIdentityAdapter,
  createSteamIdentityAdapter,
} from "../services/platform-identity-adapter";
import { TimedRoleService } from "../services/timed-role-service";
import {
  createMemberVerificationService,
  type MemberVerificationService,
} from "../services/member-verification-service";
import { ManagedMessageService } from "../services/managed-message-service";
import { ManagedMediaService } from "../managed-media";
import type { PublicManagedMediaStore } from "../managed-media";
import { MessageTemplateService } from "../services/message-template-service";
import {
  WebhookProxyService,
  type WebhookProxyConfigCache,
} from "../services/webhook-proxy-service";
import {
  BanCaseService,
  type BanCaseSourceCache,
  type ForumTagIds,
} from "../services/ban-case-service";
import { ClanService } from "../services/clan-service";
import { ClanFeatureSetupService } from "../services/clan-feature-setup";
import { SuggestionService } from "../services/suggestion-service";
import { createDiscordSuggestionProjection } from "../discord/suggestions";
import {
  createMemoryOperationalIncidentStore,
  OperationalIncidentService,
} from "../operations/incidents";
import { FeatureSetupRunner } from "../services/feature-setup-runner";
import {
  createClanCategory,
  createClanRole,
  createClanTextChannel,
  createClanVoiceChannel,
  deleteClanRole,
  inspectClanResources,
  setClanArchivedPermissions,
  upsertClanRequestPanel,
  createClanRequestReviewTicket,
  updateClanRequestReviewTicket,
} from "../discord/clans";
import {
  createSetupCategory,
  createSetupRole,
  createSetupTextChannel,
} from "../discord/setup-resources";
import {
  EvidenceVaultService,
  buildEvidenceVaultPlaceholderMessageWithOptions,
} from "../evidence-vault";
import {
  postMessageAuditEvent,
  postClanAuditEvent,
  postPlayerCountAuditEvent,
  postSuggestionAuditEvent,
} from "../services/guild-audit-log-service";
import type { GuildNotificationChannelStore } from "../services/activity-log";
import type { EvidenceVaultBlobStore, RuntimeStores } from "./app-types";
import type { EvidenceMediaCapability } from "../security/evidence-media-capability";
import type { WebhookCredentialService } from "../security/webhook-credentials/store";
import { parseDiscordWebhookCredential } from "../security/webhook-credentials";
import { createGuildBrandingResolver } from "./guild-branding";
import { createJsonKvCache } from "./discord-json-cache";
import {
  getCachedGuildTicketResources,
  getCoalescedGuildTicketResources,
} from "./admin-discord-cache";
import type { WhiteLabelBotStore } from "./contracts";
import type { SuggestionStore } from "./contracts";
import { GuildServicePolicy } from "./guild-service-policy";
import {
  DISCORD_PERMISSION_FLAGS,
  getBaseGuildPermissions,
  getChannelPermissions,
  hasPermission,
} from "./admin-permissions";
import type { GatewayService } from "../services/gateway-service";
import {
  createDiscordTicketPanelAdapter,
  createTicketPanelService,
} from "../services/tickets/ticket-panel";
import {
  createTicketLifecycle,
  type TicketRecoveryEnvelope,
} from "../services/tickets/ticket-lifecycle";
import type { ComponentIdSigner } from "../security/component-id-signer";
import type { ProductAnalyticsReporter } from "../product-analytics";
import { signSensitiveMessageComponentIds } from "../security/sensitive-component-ids";
import { ServerLevelProcessor } from "../server-levels/processor";
import type { reportOperationalEvent } from "../observability/operational-reporter";

export interface ServiceFactory {
  gatewayService?: GatewayService;
  blocklistService: BlocklistService;
  timedRoleService: TimedRoleService;
  marketplaceService: MarketplaceService;
  lfgService: LfgService;
  eventsService: EventsService;
  eventTeamDeliveryService?: EventTeamDeliveryService;
  playerCountService: PlayerCountService;
  webhookProxyService: WebhookProxyService;
  platformLinkService: PlatformLinkService;
  evidenceVaultService: EvidenceVaultService;
  banCaseService: BanCaseService;
  banCaseEnforcement?: BanCaseEnforcement;
  memberVerificationService: MemberVerificationService;
  managedMessageService: ManagedMessageService;
  managedMediaService: ManagedMediaService;
  messageTemplateService?: MessageTemplateService;
  clanService?: ClanService;
  clanFeatureSetupService?: ClanFeatureSetupService;
  suggestionService: SuggestionService;
  operationalIncidentService: OperationalIncidentService;
  ticketPanelService: ReturnType<typeof createTicketPanelService>;
  ticketLifecycle: ReturnType<typeof createTicketLifecycle>;
  serverLevelProcessor?: ServerLevelProcessor;
}

export interface ServiceFactoryOptions {
  wardogs?: WardogsService;
  banEnforcementStore?: EnforcementStore;
  banIncidentStore?: BanIncidentStore;
  banCasesEnabled?: boolean;
  wardogsPlayerCountEnabled?: boolean;
  playerCountEnabled?: boolean;
  reportOperationalEvent?: typeof reportOperationalEvent;
  stores: RuntimeStores;
  discordBotToken: string;
  discordBotUserId?: string;
  guildResources?: GuildResourceValidator;
  discordCacheKv?: KVNamespace;
  steamWebApiKey?: string;
  webhookProxyLogPersistenceEnabled?: boolean;
  webhookProxyDeliveryQueue?: QueueProducer<unknown>;
  steamBanLookupQueue?: QueueProducer<unknown>;
  ticketRecoveryQueue?: QueueProducer<TicketRecoveryEnvelope>;
  evidenceVaultBlobs?: EvidenceVaultBlobStore;
  publicManagedMedia?: PublicManagedMediaStore;
  evidenceMediaCapability?: EvidenceMediaCapability;
  webhookCredentialService?: WebhookCredentialService;
  origin?: string;
  publicUrl?: string;
  turnstileSiteKey?: string;
  turnstileSecretKey?: string;
  steamLinkAvailable?: boolean;
  waitUntil?: (promise: Promise<unknown>) => void;
  playerCountStreakReportedStore?: PlayerCountStreakReportedStore;
  whiteLabelBotStore?: WhiteLabelBotStore;
  publicWebhookSourceCaches?: {
    webhookProxy: WebhookProxyConfigCache;
    banCase: BanCaseSourceCache;
  };
  componentIdSigner?: ComponentIdSigner;
  productAnalytics?: ProductAnalyticsReporter;
  serverLevelsEnabled?: boolean;
}

export function createServiceFactory(options: ServiceFactoryOptions): ServiceFactory {
  const guildResources =
    options.guildResources ??
    createDiscordGuildResourceValidator(options.discordBotToken, (guildId) =>
      getCoalescedGuildTicketResources(guildId, options.discordBotToken),
    );
  const guildServicePolicy = new GuildServicePolicy(options.stores.guildServiceSuspensions);
  const serverLevelLinkProcessor = options.stores.serverLevels
    ? new ServerLevelProcessor({
        store: options.stores.serverLevels,
        platformLinks: options.stores.platformLink,
        readEntitlementTier: async (guildId) =>
          (await options.stores.guildEntitlements.readGuildEntitlement(guildId)).tier,
        isCurrentGuildMember: async (guildId, userId) =>
          (await fetchGuildMember(guildId, userId, options.discordBotToken)) !== null,
        isKillSwitchEnabled: () => options.serverLevelsEnabled === false,
      })
    : null;
  const evidenceViewCooldownCache = createJsonKvCache<{ expiresAtMs: number }>(
    options.discordCacheKv,
  );
  const brandingResolver = createGuildBrandingResolver(options.whiteLabelBotStore);
  const discordMessages = {
    createChannelMessage: (channelId: string, body: Parameters<typeof createChannelMessage>[1]) =>
      signSensitiveMessageComponentIds(body, options.componentIdSigner).then((signed) =>
        createChannelMessage(channelId, signed, options.discordBotToken),
      ),
    editChannelMessage: (
      channelId: string,
      messageId: string,
      body: Parameters<typeof editChannelMessage>[2],
    ) =>
      signSensitiveMessageComponentIds(body, options.componentIdSigner).then((signed) =>
        editChannelMessage(channelId, messageId, signed, options.discordBotToken),
      ),
    deleteChannelMessage: (channelId: string, messageId: string) =>
      deleteChannelMessage(channelId, messageId, options.discordBotToken),
    createUserDmMessage: (userId: string, body: Parameters<typeof createUserDmMessage>[1]) =>
      signSensitiveMessageComponentIds(body, options.componentIdSigner, {
        actorUserId: userId,
        expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
      }).then((signed) => createUserDmMessage(userId, signed, options.discordBotToken)),
    addGuildMemberRole: (guildId: string, userId: string, roleId: string) =>
      addGuildMemberRole(guildId, userId, roleId, options.discordBotToken),
    removeGuildMemberRole: (guildId: string, userId: string, roleId: string) =>
      removeGuildMemberRole(guildId, userId, roleId, options.discordBotToken),
    modifyChannel: (channelId: string, body: { name: string }) =>
      modifyChannel(channelId, body, options.discordBotToken),
    deleteChannel: (channelId: string) => deleteChannel(channelId, options.discordBotToken),
    createPrivateVoiceChannel: (input: Parameters<typeof createLfgPrivateVoiceChannel>[0]) =>
      createLfgPrivateVoiceChannel(input, options.discordBotToken),
    updatePrivateVoiceChannelAccess: (
      input: Parameters<typeof updateLfgPrivateVoiceChannelAccess>[0],
    ) => updateLfgPrivateVoiceChannelAccess(input, options.discordBotToken),
    waitUntil: options.waitUntil,
  };

  const clanService = options.stores.clans
    ? new ClanService(
        options.stores.clans,
        {
          createCategory: ({ guildId, name }) =>
            createClanCategory(guildId, name, options.discordBotToken),
          createRole: ({ guildId, name }) => createClanRole(guildId, name, options.discordBotToken),
          createTextChannel: (input) => createClanTextChannel(input, options.discordBotToken),
          createVoiceChannel: (input) => createClanVoiceChannel(input, options.discordBotToken),
          addMemberRole: (guildId, userId, roleId) =>
            addGuildMemberRole(guildId, userId, roleId, options.discordBotToken),
          removeMemberRole: (guildId, userId, roleId) =>
            removeGuildMemberRole(guildId, userId, roleId, options.discordBotToken),
          deleteChannel: (channelId) => deleteChannel(channelId, options.discordBotToken),
          deleteRole: (guildId, roleId) => deleteClanRole(guildId, roleId, options.discordBotToken),
          setClanArchivedPermissions: (input) =>
            setClanArchivedPermissions(input, options.discordBotToken),
          inspectClanResources: (input) => inspectClanResources(input, options.discordBotToken),
          upsertRequestPanel: ({ config }) =>
            upsertClanRequestPanel(config, options.discordBotToken),
          createRequestReviewTicket: (input) =>
            createClanRequestReviewTicket(
              input,
              options.discordBotToken,
              options.componentIdSigner,
            ),
          updateRequestReviewTicket: (input) =>
            updateClanRequestReviewTicket(
              input,
              options.discordBotToken,
              options.componentIdSigner,
            ),
          sendDm: (userId, message) =>
            createUserDmMessage(
              userId,
              { content: message, allowed_mentions: { parse: [] } },
              options.discordBotToken,
            ).then(() => undefined),
        },
        {
          getTier: async (guildId) =>
            (await options.stores.guildEntitlements.readGuildEntitlement(guildId)).tier,
        },
        options.discordBotUserId ?? "",
        Date.now,
        () => crypto.randomUUID(),
        (event) => postClanAuditEvent(event, options.stores.guildAuditLog, options.discordBotToken),
      )
    : undefined;
  const setupPermissionResources = new Map<
    string,
    ReturnType<typeof getGuildPermissionResources>
  >();
  const readSetupPermissionResources = (guildId: string) => {
    const cached = setupPermissionResources.get(guildId);
    if (cached) return cached;
    const pending = getGuildPermissionResources(
      guildId,
      options.discordBotUserId!,
      options.discordBotToken,
    );
    setupPermissionResources.set(guildId, pending);
    return pending;
  };
  const clanFeatureSetupService =
    options.stores.clans && options.stores.featureSetup && options.discordBotUserId
      ? new ClanFeatureSetupService(
          options.stores.clans,
          new FeatureSetupRunner(options.stores.featureSetup),
          {
            async preflight(input) {
              const context = {
                guildId: input.guildId,
                botUserId: options.discordBotUserId!,
                ...(await readSetupPermissionResources(input.guildId)),
              };
              const permissions = getBaseGuildPermissions(context);
              if (
                input.needsManageChannels &&
                !hasPermission(permissions, DISCORD_PERMISSION_FLAGS.manageChannels)
              ) {
                throw new Error("HAF needs Manage Channels before it can create Clan resources.");
              }
              if (
                input.needsManageRoles &&
                !hasPermission(permissions, DISCORD_PERMISSION_FLAGS.manageRoles)
              ) {
                throw new Error(
                  "HAF needs Manage Roles before it can create the Clan Reviewer role.",
                );
              }
            },
            async readResource(guildId, resourceId, kind) {
              const permissionResources = await readSetupPermissionResources(guildId);
              const resources = {
                channels: permissionResources.channels,
                roles: permissionResources.roles,
              };
              if (kind === "role") {
                const role = resources.roles.find(
                  (candidate) =>
                    candidate.id === resourceId &&
                    candidate.id !== guildId &&
                    candidate.managed !== true,
                );
                if (!role)
                  throw new Error("The selected role is missing, managed, or not in this Guild.");
                return { id: role.id, name: role.name, kind };
              }
              const expectedType = kind === "category" ? 4 : 0;
              const channel = resources.channels.find(
                (candidate) => candidate.id === resourceId && candidate.type === expectedType,
              );
              if (!channel) {
                throw new Error(
                  `The selected ${kind === "category" ? "category" : "text channel"} is missing or has the wrong type.`,
                );
              }
              const context = {
                guildId,
                botUserId: options.discordBotUserId!,
                ...permissionResources,
              };
              const permissions = getChannelPermissions(context, channel);
              if (!hasPermission(permissions, DISCORD_PERMISSION_FLAGS.viewChannel)) {
                throw new Error("HAF cannot view the selected Discord resource.");
              }
              if (
                kind === "text_channel" &&
                !hasPermission(permissions, DISCORD_PERMISSION_FLAGS.sendMessages)
              ) {
                throw new Error("HAF cannot send messages in the selected panel channel.");
              }
              return { id: channel.id, name: channel.name, kind };
            },
            createCategory: (input) =>
              createSetupCategory(
                { ...input, botUserId: options.discordBotUserId! },
                options.discordBotToken,
              ),
            createTextChannel: (input) => createSetupTextChannel(input, options.discordBotToken),
            createRole: (input) => createSetupRole(input, options.discordBotToken),
          },
          Date.now,
          () => crypto.randomUUID(),
          (event) =>
            postClanAuditEvent(event, options.stores.guildAuditLog, options.discordBotToken),
        )
      : undefined;
  let suggestionService: SuggestionService;
  const operationalIncidentService = new OperationalIncidentService(
    options.stores.operationalIncidents ?? createMemoryOperationalIncidentStore(),
  );
  suggestionService = new SuggestionService(
    options.stores.suggestions ?? createDisabledSuggestionStore(),
    createDiscordSuggestionProjection({
      token: options.discordBotToken,
      componentIdSigner: options.componentIdSigner,
      guildResources,
      readConfig: (guildId) => suggestionService.getConfig(guildId),
      resolveReplyWebhook: async (guildId, credentialId) => {
        if (!options.webhookCredentialService) {
          throw new Error("Webhook credential encryption is unavailable.");
        }
        const revealed = await options.webhookCredentialService.resolve(credentialId, {
          kind: "suggestion_reply",
          guildId,
          publicId: "reply-webhook",
        });
        const parsed = await parseDiscordWebhookCredential(revealed.url);
        return { id: parsed.webhookId, token: parsed.token };
      },
    }),
    Date.now,
    () => crypto.randomUUID(),
    (event) =>
      postSuggestionAuditEvent(event, options.stores.guildAuditLog, options.discordBotToken),
  );
  const eventStore = options.stores.events;
  const eventTeamDeliveryService =
    eventStore?.listDueEventTeamDeliveries &&
    eventStore?.claimEventTeamDelivery &&
    eventStore?.updateEventTeamDelivery
      ? new EventTeamDeliveryService({
          store: eventStore as EventTeamDeliveryStore,
          discord: {
            sendUserDm: (userId, body) =>
              createUserDmMessage(userId, body, options.discordBotToken),
            editChannelMessage: (channelId, messageId, body) =>
              editChannelMessage(channelId, messageId, body, options.discordBotToken),
          },
          observeMetrics: (metrics) => {
            console.info({
              event: "haf.metric",
              metric: "event_team_delivery",
              ...metrics,
            });
          },
        })
      : undefined;

  return {
    serverLevelProcessor: serverLevelLinkProcessor ?? undefined,
    suggestionService,
    operationalIncidentService,
    eventTeamDeliveryService,
    clanService,
    clanFeatureSetupService,
    ticketPanelService: createTicketPanelService({
      store: options.stores.tickets,
      entitlements: options.stores.guildEntitlements,
      guildResources,
      discord: createDiscordTicketPanelAdapter({
        discordBotToken: options.discordBotToken,
        auditStore: options.stores.guildAuditLog,
        guildResources,
      }),
      recoveryQueue: options.ticketRecoveryQueue,
      configurationRevisions: options.stores.configurationRevisions,
    }),
    ticketLifecycle: createTicketLifecycle({
      tickets: options.stores.tickets,
      blocklist: options.stores.blocklist,
      entitlements: options.stores.guildEntitlements,
      messageTemplates: options.stores.messageTemplates,
      recoveryQueue: options.ticketRecoveryQueue,
      productAnalytics: options.productAnalytics,
    }),
    blocklistService: new BlocklistService(
      options.stores.blocklist,
      (channelId, body) =>
        createChannelMessage(channelId, body, options.discordBotToken).then(() => undefined),
      options.stores.guildEntitlements,
      options.stores.guildAuditLog,
    ),
    timedRoleService: new TimedRoleService(
      options.stores.timedRoles,
      options.discordBotToken,
      guildResources,
      (guildId, userId, roleId) =>
        addGuildMemberRole(guildId, userId, roleId, options.discordBotToken),
      (guildId, userId, roleId) =>
        removeGuildMemberRole(guildId, userId, roleId, options.discordBotToken),
      options.stores.blocklist as Partial<GuildNotificationChannelStore>,
      (channelId, body) =>
        createChannelMessage(channelId, body, options.discordBotToken).then(() => undefined),
      (userId, body) =>
        createUserDmMessage(userId, body, options.discordBotToken).then(() => undefined),
      async (assignment) => {
        const [guild, roles] = await Promise.all([
          fetchGuildSummary(assignment.guildId, options.discordBotToken),
          listGuildRoles(assignment.guildId, options.discordBotToken),
        ]);
        return {
          guildName: guild.name,
          roleName: roles.find((role) => role.id === assignment.roleId)?.name ?? null,
        };
      },
      (guildId) => brandingResolver.resolveFooterText(guildId),
      options.stores.guildAuditLog,
      undefined,
      undefined,
      async (guildId, userId) => {
        const member = await fetchGuildMember(guildId, userId, options.discordBotToken);
        if (!member || !Array.isArray(member.roles)) {
          throw new Error("The selected member is no longer in this Guild.");
        }
        return member.roles;
      },
      async (guildId) => {
        if (!options.discordBotUserId) {
          throw new Error("The Discord bot user is not configured.");
        }
        const member = await fetchGuildMember(
          guildId,
          options.discordBotUserId,
          options.discordBotToken,
        );
        if (!member || !Array.isArray(member.roles)) {
          throw new Error("The bot is no longer in this Guild.");
        }
        return member.roles;
      },
    ),
    marketplaceService: new MarketplaceService(
      options.stores.marketplace,
      discordMessages,
      options.stores.guildAuditLog,
      guildResources,
    ),
    lfgService: new LfgService(
      options.stores.lfg,
      discordMessages,
      options.stores.guildAuditLog,
      options.stores.clans
        ? {
            readMembership: (guildId, userId) =>
              options.stores.clans!.readActiveMembership(guildId, userId),
            readClan: (guildId, clanId) => options.stores.clans!.readClan(guildId, clanId),
            isPublicAttributionEnabled: async (guildId) =>
              (await options.stores.clans!.readConfig(guildId))?.publicLfgAttributionEnabled ??
              true,
          }
        : undefined,
      guildResources,
      options.productAnalytics,
    ),
    eventsService: new EventsService(
      options.stores.events,
      {
        createChannelMessage: (channelId, body) =>
          createChannelMessage(channelId, body, options.discordBotToken),
        editChannelMessage: (channelId, messageId, body) =>
          editChannelMessage(channelId, messageId, body, options.discordBotToken),
        createThread: (input) => createMessageThread(input, options.discordBotToken),
        addThreadMember: (threadId, userId) =>
          addThreadMember(threadId, userId, options.discordBotToken),
        removeThreadMember: (threadId, userId) =>
          removeThreadMember(threadId, userId, options.discordBotToken),
        addGuildMemberRole: (guildId, userId, roleId) =>
          addGuildMemberRole(guildId, userId, roleId, options.discordBotToken),
        removeGuildMemberRole: (guildId, userId, roleId) =>
          removeGuildMemberRole(guildId, userId, roleId, options.discordBotToken),
      },
      options.stores.guildAuditLog,
      options.stores.guildEntitlements,
      undefined,
      guildResources,
    ),
    playerCountService: new PlayerCountService(options.stores.playerCount, {
      discordBotToken: options.discordBotToken,
      reportOperationalEvent: options.reportOperationalEvent,
      modifyChannel: (channelId, body) => modifyChannel(channelId, body, options.discordBotToken),
      enabled: options.playerCountEnabled,
      isGuildSuspended: (guildId) => guildServicePolicy.isGuildSuspended(guildId),
      resolveStatusProvider: createPlayerCountStatusProviderResolver({
        "wardogs-rcon": createWardogsPlayerCountStatusProvider({
          wardogs: options.wardogs,
          enabled: options.wardogsPlayerCountEnabled ?? false,
        }),
        "steam-web": createSteamWebPlayerCountStatusProvider({ apiKey: options.steamWebApiKey }),
      }),
      streakReportedStore: options.playerCountStreakReportedStore ?? {
        isStreakReported: async () => false,
        markStreakReported: async () => {},
        clearStreakReported: async () => {},
      },
      postPlayerCountAuditEvent: (input) =>
        postPlayerCountAuditEvent(
          "player-count.fetch-failed",
          input,
          options.stores.guildAuditLog,
          options.discordBotToken,
          guildResources,
        ),
      postPlayerCountDeletionAuditEvent: (input) =>
        postPlayerCountAuditEvent(
          "player-count.server-delete",
          input,
          options.stores.guildAuditLog,
          options.discordBotToken,
          guildResources,
        ),
      guildEntitlements: options.stores.guildEntitlements,
      operationalIncidents: operationalIncidentService,
      guildResources,
    }),
    webhookProxyService: new WebhookProxyService(options.stores.webhookProxy, {
      persistDeliveryLogs: options.webhookProxyLogPersistenceEnabled,
      deliveryQueue: options.webhookProxyDeliveryQueue,
      steamBanLookupQueue: options.steamBanLookupQueue,
      waitUntil: options.waitUntil,
      guildEntitlements: options.stores.guildEntitlements,
      isGuildSuspended: (guildId) => guildServicePolicy.isGuildSuspended(guildId),
      credentialService: options.webhookCredentialService,
      operationalIncidents: operationalIncidentService,
      configCache: options.publicWebhookSourceCaches?.webhookProxy,
    }),
    platformLinkService: createPlatformLinkService({
      platformLinkStore: options.stores.platformLink,
      discordBotToken: options.discordBotToken,
      guildEntitlementStore: options.stores.guildEntitlements,
      guildAuditLogStore: options.stores.guildAuditLog,
      guildResources,
      identityAdapters: {
        steam: createSteamIdentityAdapter({ steamWebApiKey: options.steamWebApiKey }),
        xbox: createPlatformIdentityAdapter("xbox"),
        playstation: createPlatformIdentityAdapter("playstation"),
      },
      productAnalytics: options.productAnalytics,
      waitUntil: options.waitUntil,
      onLinksReplacing: async (link, replaceLinks) => {
        if (!serverLevelLinkProcessor || link.platform !== "steam") return replaceLinks();
        await serverLevelLinkProcessor.replaceLinkedIdentities(link, replaceLinks);
      },
      onLinksRemoving: async (links, removedAtMs) => {
        if (!serverLevelLinkProcessor) return;
        const steamLinks = links.filter((link) => link.platform === "steam");
        for (const link of steamLinks) {
          await serverLevelLinkProcessor.stopEarningForLinkedIdentity({
            guildId: link.guildId,
            userId: link.userId,
            steamId64: link.platformId,
            removedAtMs,
            linkSnapshot: link,
          });
        }
      },
    }),
    evidenceVaultService: new EvidenceVaultService(
      options.stores,
      options.evidenceVaultBlobs,
      {
        deleteMessage: (channelId, messageId) =>
          deleteChannelMessage(channelId, messageId, options.discordBotToken),
        postPlaceholder: (channelId, recordId, hiderDisplayName, hasEvidenceFields, guildId) =>
          signSensitiveMessageComponentIds(
            buildEvidenceVaultPlaceholderMessageWithOptions(
              recordId,
              hiderDisplayName,
              hasEvidenceFields === true,
            ),
            options.componentIdSigner,
            { guildId },
          ).then((body) => createChannelMessage(channelId, body, options.discordBotToken)),
        postAudit: (channelId, body) =>
          createChannelMessage(channelId, body, options.discordBotToken).then(() => undefined),
      },
      undefined,
      undefined,
      undefined,
      {
        get: async (key) => (await evidenceViewCooldownCache.get(key))?.expiresAtMs ?? null,
        put: async (key, expiresAtMs, ttlSeconds) =>
          evidenceViewCooldownCache.put(key, { expiresAtMs }, { ttlSeconds }),
      },
      options.evidenceMediaCapability,
    ),
    banCaseEnforcement: createBanCaseEnforcementRuntime({
      ...options,
      operationalIncidentService: options.banIncidentStore
        ? new OperationalIncidentService(options.banIncidentStore)
        : undefined,
    }),
    banCaseService: new BanCaseService(options.stores.banCases, {
      discord: {
        createForumThread: async (input) =>
          createForumThread(
            {
              ...input,
              message: await signSensitiveMessageComponentIds(
                input.message,
                options.componentIdSigner,
              ),
            },
            options.discordBotToken,
          ),
        createChannelMessage: (channelId, body) =>
          signSensitiveMessageComponentIds(body, options.componentIdSigner).then((signed) =>
            createChannelMessage(channelId, signed, options.discordBotToken).then(() => undefined),
          ),
        editChannelMessage: (channelId, messageId, body) =>
          signSensitiveMessageComponentIds(body, options.componentIdSigner).then((signed) =>
            editChannelMessage(channelId, messageId, signed, options.discordBotToken).then(
              () => undefined,
            ),
          ),
        modifyThread: (threadId, appliedTags) =>
          modifyThread(threadId, { appliedTags }, options.discordBotToken),
        postAudit: (eventId, data) =>
          postMessageAuditEvent(
            eventId,
            {
              guildId: data.guildId,
              channelId: data.channelId,
              messageId: data.messageId,
              content: data.content,
              author: { id: data.authorId },
            },
            options.stores.guildAuditLog,
            options.discordBotToken,
          ),
      },
      guildEntitlements: options.stores.guildEntitlements,
      guildAuditLog: options.stores.guildAuditLog,
      waitUntil: options.waitUntil,
      resolveForumTags: (guildId, forumChannelId) =>
        resolveBanCaseForumTags(guildId, forumChannelId, options.discordBotToken),
      sourceCache: options.publicWebhookSourceCaches?.banCase,
    }),
    memberVerificationService: createMemberVerificationService({
      store: options.stores.memberVerification,
      guildEntitlementStore: options.stores.guildEntitlements,
      guildResources,
      guildAuditLogStore: options.stores.guildAuditLog,
      discordBotToken: options.discordBotToken,
      addGuildMemberRole: (guildId, userId, roleId) =>
        addGuildMemberRole(guildId, userId, roleId, options.discordBotToken),
      guildMemberHasRole: (guildId, userId, roleId) =>
        guildMemberHasRole(guildId, userId, roleId, options.discordBotToken),
      readGuildMember: async (guildId, userId) => {
        const member = await fetchGuildMember(guildId, userId, options.discordBotToken);
        return member ? { ...member.user, id: userId } : null;
      },
      resolveGuildName: async (guildId) => {
        try {
          const guild = await fetchGuildSummary(guildId, options.discordBotToken);
          return guild.name;
        } catch {
          return null;
        }
      },
      sendUserDm: (userId, body) =>
        signSensitiveMessageComponentIds(body, options.componentIdSigner, {
          actorUserId: userId,
          expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
        }).then((signed) => createUserDmMessage(userId, signed, options.discordBotToken)),
      createChannelMessage: (channelId, body) =>
        signSensitiveMessageComponentIds(body, options.componentIdSigner).then((signed) =>
          createChannelMessage(channelId, signed, options.discordBotToken),
        ),
      editChannelMessage: (channelId, messageId, body) =>
        signSensitiveMessageComponentIds(body, options.componentIdSigner).then((signed) =>
          editChannelMessage(channelId, messageId, signed, options.discordBotToken).then(
            () => undefined,
          ),
        ),
      resolveFooterText: (guildId) => brandingResolver.resolveFooterText(guildId),
      publicUrl: options.publicUrl,
      turnstileSiteKey: options.turnstileSiteKey,
      turnstileSecretKey: options.turnstileSecretKey,
      platformLinkStore: options.stores.platformLink,
      steamLinkAvailable: options.steamLinkAvailable,
      createSteamLinkState: async (guildId, userId) => {
        const state = crypto.randomUUID();
        await options.stores.platformLink.createPendingPlatformLink({
          state,
          guildId,
          userId,
          platform: "steam",
          createdAtMs: Date.now(),
        });
        return state;
      },
      productAnalytics: options.productAnalytics,
      configurationRevisions: options.stores.configurationRevisions,
    }),
    managedMessageService: new ManagedMessageService({
      store: options.stores.managedMessages,
      guildEntitlements: options.stores.guildEntitlements,
      guildAuditLog: options.stores.guildAuditLog,
      discordBotToken: options.discordBotToken,
      guildResources: {
        async read(guildId) {
          const resources = await getCachedGuildTicketResources(
            guildId,
            options.discordBotToken,
            false,
          );
          return {
            textChannelIds: resources.channels
              .filter((channel) => channel.type === 0)
              .map((channel) => channel.id),
            roleIds: resources.roles.map((role) => role.id),
          };
        },
      },
      operationalIncidents: operationalIncidentService,
      managedMedia: options.publicManagedMedia,
    }),
    managedMediaService: new ManagedMediaService(options.publicManagedMedia),
    ...(options.stores.messageTemplates
      ? {
          messageTemplateService: new MessageTemplateService({
            store: options.stores.messageTemplates,
            guildEntitlements: options.stores.guildEntitlements,
            guildAuditLog: options.stores.guildAuditLog,
            discordBotToken: options.discordBotToken,
          }),
        }
      : {}),
  };
}

function createDisabledSuggestionStore(): SuggestionStore {
  const unavailable = async () => {
    throw new Error("Suggestions store is unavailable.");
  };
  return new Proxy({} as SuggestionStore, {
    get(_target, property) {
      if (
        property === "readConfig" ||
        property === "readSuggestion" ||
        property === "readSuggestionByThread" ||
        property === "readLatestSuggestionByAuthor" ||
        property === "readConsideredReplyById" ||
        property === "readConsideredReply" ||
        property === "readConsideredReplyByMessage" ||
        property === "readPendingSubmission"
      )
        return async () => null;
      if (
        property === "listDigestConfigs" ||
        property === "listActiveSuggestions" ||
        property === "listSuggestions" ||
        property === "listRevisions" ||
        property === "listStatusEvents" ||
        property === "listConsideredReplies" ||
        property === "listVotes" ||
        property === "listReplyFlagMemberIds"
      )
        return async () => [];
      if (
        property === "countActiveSuggestionsByAuthor" ||
        property === "deactivateVotesForMember" ||
        property === "countReplyFlags"
      )
        return async () => 0;
      if (
        property === "updateSuggestion" ||
        property === "updateConsideredReply" ||
        property === "reserveDigestRun"
      )
        return async () => false;
      if (property === "recountVotes") return async () => ({ support: 0, oppose: 0 });
      return unavailable;
    },
  });
}

const BAN_CASE_NEW_TAG_NAME = "NEW";
const BAN_CASE_COMPLETED_TAG_NAME = "COMPLETED";

/**
 * Resolves (creating if missing) the bot-owned NEW / COMPLETED forum tags for a
 * Ban Case Forum. Tags are owned and maintained by the bot per the lifecycle
 * rule; this is best-effort and returns nulls on failure so case creation can
 * proceed without tags.
 */
async function resolveBanCaseForumTags(
  _guildId: string,
  forumChannelId: string,
  discordBotToken: string,
): Promise<ForumTagIds> {
  const channels = await import("../discord/channels");
  try {
    const tags = await channels.ensureForumTags(
      forumChannelId,
      [BAN_CASE_NEW_TAG_NAME, BAN_CASE_COMPLETED_TAG_NAME],
      discordBotToken,
    );
    const newTag = tags.find((tag) => tag.name === BAN_CASE_NEW_TAG_NAME);
    const completedTag = tags.find((tag) => tag.name === BAN_CASE_COMPLETED_TAG_NAME);
    return {
      new: newTag?.id ?? null,
      completed: completedTag?.id ?? null,
    };
  } catch {
    return { new: null, completed: null };
  }
}
