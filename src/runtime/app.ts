import { APIError } from "better-auth/api";
import { isRecord } from "../unknown-parse";
import { reportOperationalEvent } from "../observability/operational-reporter";
import { logScheduledCompletion } from "../observability/scheduled-telemetry";
import { createAdminSpaRoutes } from "./admin-spa-routes";
import { createAuthRoutes } from "../routes/auth-routes";
import { browserPrivacySignalEnabled, createInsertionId } from "../product-analytics";
import { createInteractionRoutes } from "../routes/interaction-routes";
import { createMemberVerificationRoutes } from "../routes/member-verification-routes";
import { createPublicRoutes } from "../routes/public-routes";
import { purgeExpiredTicketTranscripts } from "./ticket-transcript-retention";
import { createCommerceBuyerRoutes } from "../routes/commerce-buyer-routes";
import { createCommerceSupportRoutes } from "../routes/commerce-support-routes";
import { createPlatformLinkRoutes } from "../routes/platform-link-routes";
import { AdminOverviewService } from "../services/admin-overview-service";
import { fetchGuildMember } from "../discord/members";
import { listGuildRoles } from "../discord/guilds";
import { createAdminApiHandler } from "./admin-api";
import { buildAdminOverviewGuilds } from "./admin-overview-guilds";
import {
  createRuntimeAdminAccess,
  readAdminAccessDeniedResponse,
  type AdminAccessRequirement,
} from "./admin-access";
import { authorizeWorkspaceRequest } from "./admin-authorization";
import type { AuthorizationResult, WorkspaceMembershipResolver } from "./admin-authorization";
import {
  getCachedBotGuilds,
  getCachedCurrentUserGuilds,
  getCachedGuildSummary,
  getCachedGuildRoles,
  shouldRefreshAdminDiscordCache,
  type BotGuild,
} from "./admin-discord-cache";
import { getMemberBaseGuildPermissions } from "./admin-permissions";
import { getAdminLoginLocation, redirect, renderAdminShell } from "./admin-shell";
import type { RuntimeAppOptions } from "./app-types";
import type { CustomerAuth } from "./auth/customer-auth";
import { DiscordPaidRoleAdapter } from "./commerce/discord-paid-role-adapter";
import { DEFAULT_COMMERCE_ACCENT_COLOR, defaultCommerceBranding } from "../commerce/branding";
import { readCustomerSession } from "./auth/customer-session";
import { handleInteractionRequest } from "./interaction-handler";
import { createBanAppealPublicRoutes } from "../moderation-appeals/routes";
import { createGuildDiscoveryService, type GuildDiscoveryService } from "./discord-guild-discovery";
import { ALL_FEATURES_ENABLED } from "./features";
import {
  resolveGuildAdminAccess,
  hasAutomaticHafAdminPermission,
  hasDiscordAdministrator,
  type GuildMemberRolesFetcher,
} from "./guild-admin-access";
import { createXboxPlatformConfig } from "../services/xbox-platform-config";
import { createSteamPlatformConfig } from "../services/steam-platform-config";
import type { WorkspaceRole, WorkspaceSummary } from "./workspace-types";
import { WorkspaceGuildAlreadyLinkedError, type WorkspaceStore } from "./workspace-store";
import { createBillingApiHandler } from "./billing/billing-api";
import { createBillingAssignmentService } from "./billing/assignments";
import {
  GUILD_SERVICE_UNAVAILABLE_MESSAGE,
  GuildServicePolicy,
  findGuildIdInValue,
} from "./guild-service-policy";

export { escapeHtmlAttribute } from "./admin-shell";
export type { RuntimeAppOptions } from "./app-types";

function discordGuildIconUrl(guildId: string, icon: string | null | undefined): string | null {
  if (!/^[A-Za-z0-9_-]{2,100}$/.test(guildId) || !icon || !/^[A-Za-z0-9_-]{2,200}$/.test(icon)) {
    return null;
  }
  return `https://cdn.discordapp.com/icons/${encodeURIComponent(guildId)}/${encodeURIComponent(icon)}.png?size=128`;
}

export function createRuntimeApp(options: RuntimeAppOptions) {
  const operationalReporter = options.reportOperationalEvent ?? reportOperationalEvent;
  const runTask = (name: string, task: () => Promise<unknown>) =>
    runScheduledTask(
      name,
      async () => {
        await task();
        logScheduledCompletion(name, options);
      },
      operationalReporter,
    );
  const guildServicePolicy = new GuildServicePolicy(options.stores.guildServiceSuspensions);
  const features = options.features ?? ALL_FEATURES_ENABLED;
  // The selected feature-service graph is composed once before the app is
  // created and is consumed as-is here. HTTP dispatch, direct job delivery and
  // scheduled maintenance all exercise these same instances; nothing rebuilds
  // or partially overrides the graph at request time.
  const services = options.services;
  const {
    timedRoleService,
    blocklistService,
    webhookProxyService,
    platformLinkService,
    lfgService,
    eventsService,
    eventTeamDeliveryService,
    playerCountService,
    banCaseService,
    managedMessageService,
    operationalIncidentService,
    clanService,
    suggestionService,
  } = services;
  const gatewayService = services.gatewayService;
  const readCustomerAdminSession =
    options.readCustomerAdminSession ??
    (async (request: Request) => readCustomerSession(request, options.customerAuth));
  const guildDiscoveryService =
    options.guildDiscoveryService ??
    (options.discordAccounts
      ? createGuildDiscoveryService({
          discordAccounts: options.discordAccounts,
          listUserGuilds: (accessToken, authUserId, refresh = false) =>
            getCachedCurrentUserGuilds(accessToken, refresh, authUserId, options.discordCache),
          listBotGuilds: async (refresh = false, allowStaleOnRateLimit = true) =>
            getCachedBotGuilds(
              options.discordBotToken,
              refresh,
              options.discordCache,
              allowStaleOnRateLimit,
            ),
        })
      : undefined);
  const billingAssignmentService =
    options.billingAssignmentStore && guildDiscoveryService
      ? createBillingAssignmentService({
          store: options.billingAssignmentStore,
          listEligibleGuilds: async (ownerId, discordUserId) =>
            (await guildDiscoveryService.discoverGuildsForUser(ownerId, discordUserId, true)).map(
              (guild) => ({
                guildId: guild.guildId,
                name: guild.name,
                icon: guild.icon,
              }),
            ),
          resolveGuildName: async (guildId) => {
            try {
              return (await getCachedGuildSummary(guildId, options.discordBotToken, true)).name;
            } catch {
              return null;
            }
          },
          billingUrl: options.billingUrl,
        })
      : undefined;
  const billingApiHandler = options.billingCheckoutService
    ? createBillingApiHandler({
        service: options.billingCheckoutService,
        assignments: billingAssignmentService,
        management: options.billingManagementService,
        history: options.billingHistoryStore,
        prices: options.landingPriceCatalog,
        support: options.billingSupportService,
        authorizeSupport: async (session) => {
          if (!options.hafAdminGuildId || !options.billingSupportRoleId) return false;
          const member = await fetchGuildMember(
            options.hafAdminGuildId,
            session.user.discordUserId,
            options.discordBotToken,
          );
          return (
            Array.isArray(member?.roles) && member.roles.includes(options.billingSupportRoleId)
          );
        },
        readSession: readCustomerAdminSession,
      })
    : async () => null;
  const customerAdminMode = Boolean(options.customerAuth);
  const adminOverviewService = new AdminOverviewService(
    options.stores.blocklist,
    options.stores.timedRoles,
    options.gateway,
    (config, timedRoles, refreshDiscordCache) =>
      buildAdminOverviewGuilds(config, timedRoles, options.discordBotToken, refreshDiscordCache),
  );

  const resolveCustomerWorkspaceAuthorization =
    options.customerAuth && options.workspaceStore
      ? async (request: Request, authorization: AdminAccessRequirement) => {
          const url = new URL(request.url);
          const workspaceId =
            authorization.workspaceId ??
            (await readWorkspaceIdForAuthorization(request, url)) ??
            (authorization.guildId
              ? await options.workspaceStore!.readWorkspaceIdForGuild(authorization.guildId)
              : null);
          const session = await readCustomerSession(request, options.customerAuth);
          const result = await authorizeWorkspaceRequest({
            session,
            workspaceId,
            guildId: authorization.guildId,
            mode: authorization.mode,
            workspaceStore: options.workspaceStore,
            membershipResolver: createMembershipResolver(
              request,
              options.customerAuth,
              session?.activeOrganizationId ?? null,
            ),
          });
          return result;
        }
      : undefined;
  const fetchMemberRoleIds: GuildMemberRolesFetcher = async (guildId, userId) => {
    const member = await fetchGuildMember(guildId, userId, options.discordBotToken);
    return Array.isArray(member?.roles) ? member.roles : null;
  };
  const resolveCustomerGuildAdminAuthorization = options.customerAuth
    ? async (request: Request, authorization: AdminAccessRequirement) => {
        if (
          authorization.mode === "owner" ||
          authorization.workspaceOnly ||
          (!authorization.guildId && !authorization.allowGuildAdminDirectory)
        ) {
          return null;
        }
        const session = await readCustomerSession(request, options.customerAuth);
        if (!session) {
          return null;
        }

        if (authorization.guildCapability && authorization.guildId) {
          try {
            // Access-control edits use fresh Discord evidence and never workspace/delegated authority.
            const guild = await getCachedGuildSummary(
              authorization.guildId,
              options.discordBotToken,
              true,
            );
            if (guild.owner_id === session.user.discordUserId) return session;
            if (authorization.guildCapability === "manage-server-policy") return null;
            const memberRoleIds = await fetchMemberRoleIds(
              authorization.guildId,
              session.user.discordUserId,
            );
            if (memberRoleIds === null) return null;
            const roles = await getCachedGuildRoles(
              authorization.guildId,
              options.discordBotToken,
              true,
            );
            return hasDiscordAdministrator(
              getMemberBaseGuildPermissions({
                guildId: authorization.guildId,
                roles,
                memberRoleIds,
              }).toString(),
            )
              ? session
              : null;
          } catch {
            return null;
          }
        }
        if (!authorization.guildId) {
          return (await listCustomerGuildAdminGuildIds(request, options, fetchMemberRoleIds))
            .length > 0
            ? session
            : null;
        }

        return (await hasCustomerGuildAdminAccess(
          request,
          options,
          authorization.guildId,
          session.user.discordUserId,
          fetchMemberRoleIds,
        ))
          ? session
          : null;
      }
    : undefined;
  const listAuthorizedCustomerGuildIds = options.customerAuth
    ? async (
        request: Request,
        botGuilds?: Promise<BotGuild[]>,
      ): Promise<string[] | Response | null> => {
        const session = await readCustomerSession(request, options.customerAuth);
        if (!session) {
          return Response.json({ error: "Unauthorized" }, { status: 401 });
        }

        const guildIds = new Set<string>();
        let workspaceResponse: Response | null = null;
        let workspaceAuthorized = false;
        const workspaceId = await readWorkspaceIdForAuthorization(request, new URL(request.url));
        if (resolveCustomerWorkspaceAuthorization && workspaceId) {
          const result = await resolveCustomerWorkspaceAuthorization(request, {
            mode: "read",
          });
          if (!result.ok) {
            workspaceResponse = result.response;
          } else if (options.workspaceStore) {
            workspaceAuthorized = true;
            for (const link of await options.workspaceStore.listGuildsForWorkspace(
              result.membership.workspaceId,
            )) {
              guildIds.add(link.guildId);
            }
          }
        } else if (options.workspaceStore && options.customerAuth) {
          const organizations = await listCustomerOrganizations(options.customerAuth, request);
          for (const organization of organizations) {
            if (!normalizeWorkspaceRole(organization.role)) continue;
            workspaceAuthorized = true;
            for (const link of await options.workspaceStore.listGuildsForWorkspace(
              organization.id,
            )) {
              guildIds.add(link.guildId);
            }
          }
        }

        let guildAdminGuildIds: string[] = [];
        try {
          guildAdminGuildIds = await listCustomerGuildAdminGuildIds(
            request,
            options,
            fetchMemberRoleIds,
            botGuilds,
          );
        } catch (error) {
          console.warn("Failed to resolve Guild-admin fallback access", error);
        }
        if (!workspaceAuthorized && guildIds.size === 0 && guildAdminGuildIds.length === 0) {
          return workspaceResponse ?? Response.json({ error: "Forbidden" }, { status: 403 });
        }
        for (const guildId of guildAdminGuildIds) {
          guildIds.add(guildId);
        }
        const suspendedGuildIds = new Set(await guildServicePolicy.listSuspendedGuildIds());
        return [...guildIds].filter((guildId) => !suspendedGuildIds.has(guildId));
      }
    : undefined;
  const workspaceApi =
    customerAdminMode && options.workspaceStore && options.customerAuth
      ? createWorkspaceAdminApi({
          customerAuth: options.customerAuth,
          workspaceStore: options.workspaceStore,
          guildDiscoveryService,
          resolveAuthorization: resolveCustomerWorkspaceAuthorization!,
          canCreateGuildLink: async (request, guildId) =>
            (await options.stores.guildRbac.readManageServerAdminEnabled(guildId)) ||
            (await resolveCustomerGuildAdminAuthorization!(request, {
              mode: "write",
              guildId,
              guildCapability: "manage-delegation",
            })) !== null,
        })
      : undefined;
  const adminAccess = createRuntimeAdminAccess({
    readCustomerSession: options.customerAuth ? readCustomerAdminSession : async () => null,
    authorizeWorkspaceAccess: resolveCustomerWorkspaceAuthorization
      ? async (request, authorization) => {
          const result = await resolveCustomerWorkspaceAuthorization(request, authorization);
          return result.ok
            ? { ok: true }
            : {
                ok: false,
                error: await readAdminAccessDeniedResponse(result.response),
              };
        }
      : undefined,
    authorizeGuildAccess: resolveCustomerGuildAdminAuthorization
      ? async (request, authorization) =>
          (await resolveCustomerGuildAdminAuthorization(request, authorization)) !== null
      : undefined,
  });
  const handleAdminApiRequest = createAdminApiHandler({
    resolveGuildBotIdentity: options.resolveGuildBotIdentity,
    stores: options.stores,
    discordBotToken: options.discordBotToken,
    opsFeedbackChannelId: options.opsFeedbackChannelId,
    workerVersion: options.workerVersion,
    environment: options.environment,
    reportOperationalEvent: operationalReporter,
    waitUntil: options.waitUntil,
    discordBotUserId: options.discordBotUserId,
    features,
    adminAccess,
    invalidateWebhookProxyConfig: (publicId) => {
      webhookProxyService.invalidateWebhookProxyConfig(publicId);
    },
    invalidateBanCaseSources: () => {
      banCaseService.invalidateInboundBanCaseSources();
    },
    readCustomerAdminSession,
    guildDiscoveryService,
    listAuthorizedCustomerGuildIds,
    discordSupportInvite: options.discordSupportInvite,
    discordCache: options.discordCache,
    turnstileSiteKey: options.turnstileSiteKey,
    turnstileSecretKey: options.turnstileSecretKey,
    aiTranscriptSummarizerEnv: options.aiTranscriptSummarizerEnv,
    webhookCredentialService: options.webhookCredentialService,
    webhookIngressGuard: options.webhookIngressGuard,
    authorizeAttendanceObservationAdmin: resolveCustomerGuildAdminAuthorization
      ? async (request, guildId) =>
          (await resolveCustomerGuildAdminAuthorization(request, { mode: "write", guildId })) !==
          null
      : undefined,
    attendanceObservations: options.attendanceObservations,
    wardogs: options.wardogs,
    wardogsPlayerCountEnabled: options.wardogsPlayerCountEnabled,
    serverLevelCredentialService: options.serverLevelCredentialService,
    serverLevelProcessingAvailable: options.serverLevelProcessingAvailable,
    banAppealServiceForGuild: options.banAppealServiceForGuild,
    communityTools: options.communityTools,
    reputationServiceForGuild: options.reputationServiceForGuild,
    componentIdSigner: options.componentIdSigner,
    configurationRevisionSigningSecret: options.configurationRevisionSigningSecret,
    commerce: options.commerceAdmin,
    isCommerceGuildOwner: async (guildId, discordUserId) =>
      (await getCachedGuildSummary(guildId, options.discordBotToken, true)).owner_id ===
      discordUserId,
    isCommercePlatformOperator: async (discordUserId) => {
      if (!options.hafAdminGuildId || !options.hafAdminRoleId) return false;
      const member = await fetchGuildMember(
        options.hafAdminGuildId,
        discordUserId,
        options.discordBotToken,
      );
      return Array.isArray(member?.roles) && member.roles.includes(options.hafAdminRoleId);
    },
    publicBaseUrl: options.publicUrl,
    ticketTranscriptCapabilities: options.ticketTranscriptCapabilities,
    productAnalytics: options.productAnalytics,
    guildResources: options.guildResources,
    services,
    adminRouteServices: {
      gatewayService,
      adminOverviewService,
      blocklistService,
      timedRoleService,
      managedMessageService: services.managedMessageService,
      messageTemplateService: services.messageTemplateService,
    },
    workspaceApi,
  });

  const banAppealRoutes =
    options.banAppealServiceForGuild && options.publicUrl
      ? createBanAppealPublicRoutes({
          serviceForGuild: options.banAppealServiceForGuild,
          readCustomerSession: (request) => readCustomerSession(request, options.customerAuth),
          publicBaseUrl: options.publicUrl,
        })
      : async () => null;
  const publicRoutes = createPublicRoutes({
    selfHostedSite: options.selfHostedSite,
    microsoftApplicationId: options.xboxOAuthClientId,
    landingPriceCatalog: options.landingPriceCatalog,
    discordApplicationId: options.discordApplicationId,
    discordInstallPermissions: options.discordInstallPermissions,
    ticketTranscriptBlobs: options.ticketTranscriptBlobs,
    ticketTranscriptCapabilities: options.ticketTranscriptCapabilities,
    ticketTranscriptAccessGuard: options.webhookIngressGuard,
    evidenceVaultBlobs: options.evidenceVaultBlobs,
    publicManagedMedia: options.publicManagedMedia,
    evidenceVaultStore: options.stores.evidenceVault,
    evidenceMediaCapability: options.evidenceMediaCapability,
    webhookIngressGuard: options.webhookIngressGuard,
    features,
    webhookProxyService,
    banCaseService,
    productAnalytics: options.productAnalytics,
    waitUntil: options.waitUntil,
    serverLevelIngressHandler: options.serverLevelIngressHandler,
  });
  const steamLinkRoutes = features.steamLink
    ? createPlatformLinkRoutes({
        platformLinkService,
        platformConfig: createSteamPlatformConfig({
          steamWebApiKey: options.steamWebApiKey,
        }),
      })
    : async () => null;
  const xboxLinkRoutes =
    features.xboxLink && options.xboxOAuthClientId && options.xboxOAuthClientSecret
      ? createPlatformLinkRoutes({
          platformLinkService,
          platformConfig: createXboxPlatformConfig({
            clientId: options.xboxOAuthClientId,
            clientSecret: options.xboxOAuthClientSecret,
          }),
        })
      : async () => null;
  const memberVerificationRoutes = features.memberVerification
    ? createMemberVerificationRoutes({
        memberVerificationService: services.memberVerificationService,
        customerAuth: options.customerAuth,
        turnstileSiteKey: options.turnstileSiteKey,
        turnstileSecretKey: options.turnstileSecretKey,
      })
    : async () => null;
  const commerceBuyerRoutes =
    options.commerceBuyerCheckoutService &&
    options.commercePurchaseSigningSecret &&
    options.publicUrl &&
    options.customerAuth &&
    options.discordBotUserId
      ? createCommerceBuyerRoutes({
          service: options.commerceBuyerCheckoutService,
          signingSecret: options.commercePurchaseSigningSecret,
          publicBaseUrl: options.publicUrl,
          readSession: readCustomerAdminSession,
          readMember: async (guildId, discordUserId) => {
            const member = await fetchGuildMember(guildId, discordUserId, options.discordBotToken);
            return {
              present: member !== null,
              bot: member?.user?.bot === true,
              // Discord's member endpoint returns 404 for users who are not
              // current members, including banned users.
              banned: false,
            };
          },
          roleManageable: async (guildId, discordRoleId, discordUserId) => {
            const adapter = new DiscordPaidRoleAdapter(
              options.discordBotUserId!,
              options.discordBotToken,
            );
            return (
              await adapter.preflightRole({
                guildId,
                discordRoleId,
                discordUserId,
                action: "assign",
              })
            ).ok;
          },
          readPresentation: async (guildId, discordRoleId) => {
            const [guild, roles] = await Promise.all([
              getCachedGuildSummary(guildId, options.discordBotToken, false),
              listGuildRoles(guildId, options.discordBotToken),
            ]);
            return {
              guildName: guild.name,
              roleName: roles.find(({ id }) => id === discordRoleId)?.name ?? discordRoleId,
            };
          },
          readBranding: async (guildId) => {
            const [guild, configured] = await Promise.all([
              getCachedGuildSummary(guildId, options.discordBotToken, false),
              options.commerceBrandingStore?.readByGuild(guildId) ?? Promise.resolve(null),
            ]);
            const fallback = defaultCommerceBranding(guild.name);
            return {
              guildName: guild.name,
              guildIconUrl: discordGuildIconUrl(guild.id, guild.icon),
              accentColor: configured?.accentColor ?? DEFAULT_COMMERCE_ACCENT_COLOR,
              tagline: configured?.tagline ?? fallback.tagline,
            };
          },
          readSupportEnabled: options.commerceSupportService
            ? async (guildId) =>
                options.commerceSupportService!.page(guildId).then((page) => page.config.enabled)
            : undefined,
        })
      : async () => null;
  const authRoutes = options.customerAuth
    ? createAuthRoutes({
        handle: (request) => options.customerAuth!.handler(request),
        onDiscordSignInCompleted: (request) => {
          if (!options.productAnalytics || browserPrivacySignalEnabled(request)) return;
          try {
            const delivery = options.productAnalytics
              .report({ name: "dashboard_signed_in", insertionId: createInsertionId() })
              .catch(() => undefined);
            options.waitUntil?.(delivery);
          } catch {
            // Authentication success cannot depend on product analytics.
          }
        },
      })
    : async () => null;
  const commerceSupportRoutes =
    options.commerceSupportService &&
    options.commercePurchaseSigningSecret &&
    options.publicUrl &&
    options.customerAuth
      ? createCommerceSupportRoutes({
          service: options.commerceSupportService,
          signingSecret: options.commercePurchaseSigningSecret,
          publicBaseUrl: options.publicUrl,
          readSession: readCustomerAdminSession,
          readMember: async (guildId, discordUserId) => {
            const member = await fetchGuildMember(guildId, discordUserId, options.discordBotToken);
            return {
              present: member !== null,
              bot: member?.user?.bot === true,
              banned: false,
            };
          },
          readGuildName: async (guildId) =>
            (await getCachedGuildSummary(guildId, options.discordBotToken, false)).name,
          readBranding: async (guildId) => {
            const [guild, configured] = await Promise.all([
              getCachedGuildSummary(guildId, options.discordBotToken, false),
              options.commerceBrandingStore?.readByGuild(guildId) ?? Promise.resolve(null),
            ]);
            const fallback = defaultCommerceBranding(guild.name);
            return {
              guildName: guild.name,
              guildIconUrl: discordGuildIconUrl(guild.id, guild.icon),
              accentColor: configured?.accentColor ?? DEFAULT_COMMERCE_ACCENT_COLOR,
              tagline: configured?.tagline ?? fallback.tagline,
            };
          },
        })
      : async () => null;
  const signOutCustomerAdminRequest = options.customerAuth
    ? async (request: Request) => {
        const url = new URL(request.url);
        url.pathname = "/api/auth/sign-out";
        url.search = "";
        return options.customerAuth!.handler(
          new Request(url, {
            method: "POST",
            headers: request.headers,
          }),
        );
      }
    : undefined;
  const adminRoutes = features.adminUi
    ? createAdminSpaRoutes({
        readCustomerAdminSession,
        signOutCustomerAdminRequest,
        redirect,
        getAdminLoginLocation,
        renderAdminShell,
        isAdminUiAuthorized: customerAdminMode
          ? (request) => isCustomerAdminUiAuthorized(request, options.customerAuth)
          : async () => false,
        features,
        workerVersion: options.workerVersion,
      })
    : async () => null;
  const interactionRoutes = createInteractionRoutes({
    selfHostedSite: options.selfHostedSite,
    communityTools: options.communityTools,
    reputationServiceForGuild: options.reputationServiceForGuild,
    discordPublicKey: options.discordPublicKey,
    discordBotToken: options.discordBotToken,
    hafAdminGuildId: options.hafAdminGuildId,
    hafAdminRoleId: options.hafAdminRoleId,
    attendanceObservations: options.attendanceObservations,
    verifyDiscordRequest: options.verifyDiscordRequest,
    stores: options.stores,
    gateway: options.gateway,
    ticketTranscriptBlobs: options.ticketTranscriptBlobs,
    ticketTranscriptCapabilities: options.ticketTranscriptCapabilities,
    evidenceVaultBlobs: options.evidenceVaultBlobs,
    services,
    handleInteractionRequest,
    features,
    workspaceStore: options.workspaceStore,
    waitUntil: options.waitUntil,
    componentIdSigner: options.componentIdSigner,
  });

  return {
    async fetch(request: Request): Promise<Response> {
      const requestUrl = new URL(request.url);
      const guildId =
        (await readGuildIdFromRequest(request, requestUrl)) ??
        (await readOpaqueRouteGuildId(requestUrl, services));
      if (await guildServicePolicy.isGuildSuspended(guildId)) {
        if (requestUrl.pathname === "/interactions") {
          return Response.json({
            type: 4,
            data: { content: GUILD_SERVICE_UNAVAILABLE_MESSAGE, flags: 64 },
          });
        }
        return GuildServicePolicy.buildHttpUnavailableResponse();
      }
      const billingWebhookResponse = options.billingWebhookHandler
        ? await options.billingWebhookHandler(request)
        : null;
      if (billingWebhookResponse) return billingWebhookResponse;
      const commerceWebhookResponse = options.commerceWebhookHandler
        ? await options.commerceWebhookHandler(request)
        : null;
      if (commerceWebhookResponse) return commerceWebhookResponse;
      const billingApiResponse = await billingApiHandler(request);
      if (billingApiResponse) return billingApiResponse;

      const authResponse = await authRoutes(request);
      if (authResponse) return authResponse;

      const steamLinkResponse = steamLinkRoutes ? await steamLinkRoutes(request) : null;
      if (steamLinkResponse) return steamLinkResponse;

      const xboxLinkResponse = xboxLinkRoutes ? await xboxLinkRoutes(request) : null;
      if (xboxLinkResponse) return xboxLinkResponse;

      const memberVerificationResponse = memberVerificationRoutes
        ? await memberVerificationRoutes(request)
        : null;
      if (memberVerificationResponse) return memberVerificationResponse;

      const commerceBuyerResponse = await commerceBuyerRoutes(request);
      if (commerceBuyerResponse) return commerceBuyerResponse;
      const commerceSupportResponse = await commerceSupportRoutes(request);
      if (commerceSupportResponse) return commerceSupportResponse;

      const banAppealResponse = await banAppealRoutes(request);
      if (banAppealResponse) return banAppealResponse;
      const publicResponse = await publicRoutes(request);
      if (publicResponse) return publicResponse;

      const url = new URL(request.url);
      if (features.adminUi && url.pathname.startsWith("/admin/api/")) {
        const adminApiResponse = await handleAdminApiRequest(request, url);
        if (adminApiResponse) return adminApiResponse;
      }

      const adminResponse = await adminRoutes(request);
      if (adminResponse) return adminResponse;

      const interactionResponse = await interactionRoutes(request);
      if (interactionResponse) return interactionResponse;

      return new Response("Not found", { status: 404 });
    },
    async bootstrap() {
      return gatewayService.bootstrap();
    },
    async refreshPlayerCount() {
      if (options.attendanceObservations)
        await runTask("Attendance observation", () =>
          options.attendanceObservations!.service.processDue(),
        );
      if (options.commerceGameAccess)
        await runTask("Commerce game access outbox", options.commerceGameAccess.sweepOutbox);
      if (services.banCaseEnforcement)
        await runTask("Ban Case server actions", () => services.banCaseEnforcement!.processDue());
      if (options.sweepBillingSyncOutbox) {
        await runTask("Billing sync outbox sweep", options.sweepBillingSyncOutbox);
      }
      if (options.sweepCommerceSyncOutbox) {
        await runTask("Commerce sync outbox sweep", options.sweepCommerceSyncOutbox);
      }
      if (options.sweepCommerceFinancialActions) {
        await runTask("Commerce financial action sweep", options.sweepCommerceFinancialActions);
      }
      if (options.scheduleCommerceReconciliation) {
        await runTask("Commerce reconciliation", options.scheduleCommerceReconciliation);
      }
      if (options.sweepCommerceSellerReviews) {
        await runTask(
          "Commerce seller review notification sweep",
          options.sweepCommerceSellerReviews,
        );
      }
      if (options.sweepCommerceRoleOutbox) {
        await runTask("Commerce role outbox sweep", options.sweepCommerceRoleOutbox);
      }
      if (options.reconcileCommerceRoles) {
        await runTask("Commerce role reconciliation", options.reconcileCommerceRoles);
      }
      if (options.reconcileBillingOwners) {
        await runTask("Billing owner reconciliation", options.reconcileBillingOwners);
      }
      if (options.sweepBillingDeliveryOutbox) {
        await runTask("Billing delivery outbox sweep", options.sweepBillingDeliveryOutbox);
      }
      if (options.processBillingGrace) {
        await runTask("Billing Grace processing", options.processBillingGrace);
      }
      if (options.sweepServerLevels) {
        await runTask("Server Levels processing", options.sweepServerLevels);
      }
      await runTask("Timed Role expiry", () => timedRoleService.expireDueTimedRoles());
      if (features.botDefense && options.repairBotDefenseQueueDeliveries) {
        await runTask("Bot Defense queue delivery repair", options.repairBotDefenseQueueDeliveries);
      }
      if (options.sweepReactionLimitCounterRetention) {
        await runTask(
          "Reaction Limit counter retention",
          options.sweepReactionLimitCounterRetention,
        );
      }
      if (features.lfg) {
        await runTask("LFG expiry processing", () => lfgService.processDueExpiries());
        await runTask("LFG renewal reminders", () => lfgService.sendDueRenewalReminders());
      }
      if (features.events) {
        await runTask("Event reminders", () => eventsService.processDueReminders());
        await runTask("Event lifecycle processing", () => eventsService.processDueLifecycle());
        await runTask("Recurring Event publication", () => eventsService.processDueRecurrences());
        if (eventTeamDeliveryService) {
          await runTask("Event Team delivery outbox", () => eventTeamDeliveryService.processDue());
        }
      }
      await runTask("Managed Message Scheduled Publish", () =>
        managedMessageService.processScheduledDrafts(),
      );
      await runTask("Operational Incident retention", () =>
        operationalIncidentService.purgeResolved(Date.now() - 30 * 24 * 60 * 60 * 1000, 100),
      );
      if (options.stores.adminFeedback?.purgeExpired) {
        await runTask("Admin feedback retention", () =>
          options.stores.adminFeedback!.purgeExpired(Date.now() - 180 * 24 * 60 * 60 * 1000, 100),
        );
      }
      if (clanService) {
        await runTask("Clan lifecycle processing", () =>
          clanService.processScheduledLifecycle({
            limit: 100,
            isGuildSuspended: (guildId) => guildServicePolicy.isGuildSuspended(guildId),
          }),
        );
        await runTask("Clan history retention purge", () => clanService.purgeExpiredHistory(100));
      }
      if (features.suggestions) {
        await runTask("Suggestion Digest delivery", () => suggestionService.processDueDigests());
      }
      if (options.stores.configurationRevisions?.purgeExpired) {
        await runTask("Configuration revision retention purge", () =>
          options.stores.configurationRevisions!.purgeExpired!({
            nowMs: Date.now(),
            retentionMs: 90 * 24 * 60 * 60 * 1_000,
            limit: 100,
          }),
        );
      }
      if (options.ticketTranscriptCapabilities && options.ticketTranscriptBlobs) {
        await runTask("Ticket transcript retention purge", () =>
          purgeExpiredTicketTranscripts({
            capabilities: options.ticketTranscriptCapabilities!,
            blobs: options.ticketTranscriptBlobs!,
            nowMs: Date.now(),
            limit: 100,
          }),
        );
      }
      if (!features.playerCount) return;
      try {
        await playerCountService.refreshAllServers();
        await playerCountService.renameDueChannels();
      } catch (error) {
        operationalReporter({
          severity: "error",
          code: "scheduled.player_count_refresh_failed",
          message: "Player count refresh failed",
          cause: error,
          operation: "refresh_player_count",
        });
      }
    },
  };
}

async function readOpaqueRouteGuildId(
  url: URL,
  services: Pick<
    RuntimeAppOptions["services"],
    "platformLinkService" | "memberVerificationService"
  >,
): Promise<string | null> {
  const state = url.searchParams.get("state");
  if (state && (url.pathname === "/auth/steam/start" || url.pathname === "/auth/steam/callback")) {
    return (await services.platformLinkService.readPendingLink(state))?.guildId ?? null;
  }
  if (state && (url.pathname === "/auth/xbox/start" || url.pathname === "/auth/xbox/callback")) {
    return (await services.platformLinkService.readPendingLink(state))?.guildId ?? null;
  }
  const verificationMatch = /^\/verify\/([^/]+)$/.exec(url.pathname);
  if (verificationMatch?.[1]) {
    const attemptId = decodeURIComponent(verificationMatch[1]);
    return (
      (await services.memberVerificationService.readVerificationAttempt(attemptId))?.guildId ?? null
    );
  }
  return null;
}

export async function readGuildIdFromRequest(
  request: Request,
  url = new URL(request.url),
): Promise<string | null> {
  const queryGuildId = url.searchParams.get("guildId") ?? url.searchParams.get("guild_id");
  if (queryGuildId) return queryGuildId;

  const adminGuildMatch =
    /^\/admin\/(?!api(?:\/|$)|global(?:\/|$)|login(?:\/|$)|billing(?:\/|$)|profile(?:\/|$)|gateway(?:\/|$)|workspaces(?:\/|$))([^/]+)/.exec(
      url.pathname,
    );
  if (adminGuildMatch?.[1]) return decodeURIComponent(adminGuildMatch[1]);

  if (request.method === "GET" || request.method === "HEAD") return null;
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return null;
  try {
    return findGuildIdInValue(await request.clone().json());
  } catch {
    return null;
  }
}

export async function runScheduledTask(
  name: string,
  task: () => Promise<unknown>,
  report: typeof reportOperationalEvent = reportOperationalEvent,
): Promise<void> {
  try {
    await task();
  } catch (error) {
    try {
      report({
        severity: "error",
        code: "scheduled.task_failed",
        message: `${name} failed`,
        cause: error,
        operation: name,
      });
    } catch {
      // Telemetry must not prevent later independent scheduled tasks.
    }
  }
}

type CustomerWorkspaceAuthorizationResolver = (
  request: Request,
  authorization: AdminAccessRequirement,
) => Promise<AuthorizationResult>;

async function listCustomerGuildAdminGuildIds(
  request: Request,
  options: RuntimeAppOptions,
  fetchMemberRoleIds: GuildMemberRolesFetcher,
  providedBotGuilds?: Promise<BotGuild[]>,
): Promise<string[]> {
  const session = await readCustomerSession(request, options.customerAuth);
  if (!session) {
    return [];
  }

  const url = new URL(request.url);
  const refreshDiscordCache = shouldRefreshAdminDiscordCache(url);
  const discordAccessToken = await options.discordAccounts?.readDiscordAccessToken(session.user.id);
  const [guilds, userGuilds] = await Promise.all([
    providedBotGuilds
      ? providedBotGuilds
      : getCachedBotGuilds(options.discordBotToken, refreshDiscordCache, options.discordCache),
    discordAccessToken
      ? getCachedCurrentUserGuilds(
          discordAccessToken,
          refreshDiscordCache,
          session.user.id,
          options.discordCache,
        )
      : Promise.resolve([]),
  ]);
  const botGuildIds = new Set(guilds.map((guild) => guild.guildId));
  const authorizedGuildIds: string[] = [];
  const authorizedGuildIdSet = new Set<string>();

  for (const guild of userGuilds) {
    if (
      botGuildIds.has(guild.guildId) &&
      (guild.owner ||
        (await hasAutomaticHafAdminPermission(
          guild.guildId,
          guild.permissions,
          options.stores.guildRbac,
        )))
    ) {
      authorizedGuildIds.push(guild.guildId);
      authorizedGuildIdSet.add(guild.guildId);
    }
  }

  const assignments = (await options.stores.guildRbac.listGuildAdminRoleAssignments()).filter(
    ({ guildId }) => botGuildIds.has(guildId) && !authorizedGuildIdSet.has(guildId),
  );
  const customRoleGuildIds = await mapWithConcurrency(
    assignments,
    4,
    async ({ guildId, roleId }) => {
      try {
        const memberRoleIds = await fetchMemberRoleIds(guildId, session.user.discordUserId);
        return memberRoleIds?.includes(roleId) ? guildId : null;
      } catch {
        return null;
      }
    },
  );
  for (const guildId of customRoleGuildIds) {
    if (guildId) authorizedGuildIds.push(guildId);
  }

  return authorizedGuildIds;
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  map: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from({ length: values.length }, () => undefined as R);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex++;
        results[index] = await map(values[index]);
      }
    }),
  );
  return results;
}

async function hasCustomerGuildAdminAccess(
  request: Request,
  options: RuntimeAppOptions,
  guildId: string,
  userId: string,
  fetchMemberRoleIds: GuildMemberRolesFetcher,
): Promise<boolean> {
  try {
    const refreshDiscordCache = shouldRefreshAdminDiscordCache(new URL(request.url));
    const memberRoleIds = await fetchMemberRoleIds(guildId, userId);
    if (memberRoleIds === null) {
      return false;
    }

    const appAdminAccess = await resolveGuildAdminAccess({
      guildId,
      userId,
      store: options.stores.guildRbac,
      suppliedRoleIds: memberRoleIds,
    });
    if (appAdminAccess.ok) {
      return true;
    }

    const guildSummary = await getCachedGuildSummary(
      guildId,
      options.discordBotToken,
      refreshDiscordCache,
    ).catch(() => null);
    if (guildSummary?.owner_id === userId) return true;
    const roles = await getCachedGuildRoles(guildId, options.discordBotToken, refreshDiscordCache);
    if (
      await hasAutomaticHafAdminPermission(
        guildId,
        getMemberBaseGuildPermissions({ guildId, roles, memberRoleIds }).toString(),
        options.stores.guildRbac,
      )
    ) {
      return true;
    }

    return false;
  } catch {
    return false;
  }
}

interface WorkspaceAdminApiOptions {
  customerAuth: CustomerAuth;
  workspaceStore: WorkspaceStore;
  guildDiscoveryService?: GuildDiscoveryService;
  resolveAuthorization: CustomerWorkspaceAuthorizationResolver;
  canCreateGuildLink(request: Request, guildId: string): Promise<boolean>;
}

function workspaceGuildLinkDeniedResponse(): Response {
  return Response.json({ error: "Forbidden" }, { status: 403 });
}

function createWorkspaceAdminApi(options: WorkspaceAdminApiOptions) {
  return {
    async listWorkspaces(request: Request) {
      const session = await readCustomerSession(request, options.customerAuth);
      if (!session) {
        return { workspaces: [] };
      }

      const organizations = await listCustomerOrganizations(options.customerAuth, request);
      return {
        workspaces: organizations
          .map((organization): WorkspaceSummary | null => {
            const role = normalizeWorkspaceRole(organization.role);
            if (!role) return null;
            return {
              id: organization.id,
              name: organization.name,
              slug: organization.slug,
              role,
            };
          })
          .filter((workspace): workspace is WorkspaceSummary => Boolean(workspace)),
      };
    },
    async listWorkspaceGuilds(request: Request, workspaceId: string) {
      const authorization = await options.resolveAuthorization(request, {
        mode: "read",
      });
      if (!authorization.ok) {
        return authorization.response;
      }
      return {
        workspaceId,
        guilds: await options.workspaceStore.listGuildsForWorkspace(workspaceId),
      };
    },
    async linkGuild(
      request: Request,
      body: { workspaceId: string; guildId: string },
    ): Promise<Response> {
      const authorization = await options.resolveAuthorization(request, {
        mode: "write",
        guildId: null,
      });
      if (!authorization.ok) return authorization.response;
      if (authorization.membership.workspaceId !== body.workspaceId) {
        return Response.json({ error: "Workspace access is required." }, { status: 403 });
      }
      if (!options.guildDiscoveryService) {
        return workspaceGuildLinkDeniedResponse();
      }

      try {
        const eligibleGuilds = await options.guildDiscoveryService.discoverGuildsForUser(
          authorization.session.user.id,
          authorization.session.user.discordUserId,
          true,
          { requireFreshBotGuilds: true },
        );
        if (!eligibleGuilds.some((guild) => guild.guildId === body.guildId)) {
          return workspaceGuildLinkDeniedResponse();
        }
        // Preserve existing grants; creating a new one must respect the owner's HAF policy.
        if (
          !(await options.workspaceStore.isGuildLinkedToWorkspace(
            body.workspaceId,
            body.guildId,
          )) &&
          !(await options.canCreateGuildLink(request, body.guildId))
        ) {
          return workspaceGuildLinkDeniedResponse();
        }
      } catch {
        return workspaceGuildLinkDeniedResponse();
      }

      try {
        await options.workspaceStore.linkGuildToWorkspace({
          workspaceId: body.workspaceId,
          guildId: body.guildId,
          linkedByUserId: authorization.session.user.id,
          linkedAtMs: Date.now(),
        });
      } catch (error) {
        if (error instanceof WorkspaceGuildAlreadyLinkedError) {
          return workspaceGuildLinkDeniedResponse();
        }
        throw error;
      }
      return Response.json({ ok: true });
    },
    async unlinkGuild(
      request: Request,
      body: { workspaceId: string; guildId: string },
    ): Promise<Response> {
      const authorization = await options.resolveAuthorization(request, {
        mode: "write",
        guildId: body.guildId,
      });
      if (!authorization.ok) return authorization.response;
      if (authorization.membership.workspaceId !== body.workspaceId) {
        return Response.json({ error: "Workspace access is required." }, { status: 403 });
      }
      await options.workspaceStore.unlinkGuildFromWorkspace({
        workspaceId: body.workspaceId,
        guildId: body.guildId,
        unlinkedByUserId: authorization.session.user.id,
        unlinkedAtMs: Date.now(),
      });
      return Response.json({ ok: true });
    },
  };
}

async function isCustomerAdminUiAuthorized(
  request: Request,
  customerAuth: CustomerAuth | undefined,
): Promise<boolean> {
  return (await readCustomerSession(request, customerAuth)) !== null;
}

function createMembershipResolver(
  request: Request,
  customerAuth: CustomerAuth | undefined,
  activeOrganizationId: string | null,
): WorkspaceMembershipResolver {
  return async ({ workspaceId, userId }) => {
    if (!customerAuth) return null;

    if (activeOrganizationId !== workspaceId) {
      try {
        await customerAuth.api.setActiveOrganization({
          headers: request.headers,
          body: { organizationId: workspaceId },
        });
      } catch (error) {
        if (error instanceof APIError) return null;
        throw error;
      }
    }

    const member = await customerAuth.api.getActiveMember({ headers: request.headers });
    if (!member || member.userId !== userId || member.organizationId !== workspaceId) {
      return null;
    }
    const role = normalizeWorkspaceRole(member.role);
    return role ? { workspaceId, userId, role } : null;
  };
}

async function listCustomerOrganizations(
  customerAuth: CustomerAuth,
  request: Request,
): Promise<Array<{ id: string; name: string; slug: string; role: unknown }>> {
  const api = customerAuth.api as typeof customerAuth.api & {
    listOrganizations?: (input: { headers: Headers }) => Promise<unknown>;
  };
  const result: unknown = api.listOrganizations
    ? await api.listOrganizations({ headers: request.headers })
    : [];
  const rawOrganizations: unknown[] = Array.isArray(result)
    ? result
    : isRecord(result) && Array.isArray(result.organizations)
      ? result.organizations
      : [];
  const organizations = rawOrganizations.flatMap((organization: unknown) => {
    if (!isRecord(organization)) return [];
    const id = asString(organization.id);
    const name = asString(organization.name);
    const slug = asString(organization.slug);
    if (!id || !name || !slug) return [];
    return [{ id, name, slug, role: organization.role }];
  });
  return Promise.all(
    organizations.map(async (organization) => {
      const member = await customerAuth.api.getActiveMemberRole({
        headers: request.headers,
        query: { organizationId: organization.id },
      });
      return { ...organization, role: member?.role };
    }),
  );
}

async function readWorkspaceIdForAuthorization(request: Request, url: URL): Promise<string | null> {
  const queryWorkspaceId = url.searchParams.get("workspaceId");
  if (queryWorkspaceId) {
    return queryWorkspaceId;
  }
  if (request.method === "GET" || request.method === "HEAD") {
    return null;
  }

  try {
    const body = await request.clone().json();
    return isRecord(body) && typeof body.workspaceId === "string" && body.workspaceId.length > 0
      ? body.workspaceId
      : null;
  } catch (error) {
    if (error instanceof SyntaxError) {
      return null;
    }
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

function normalizeWorkspaceRole(role: unknown): WorkspaceRole | null {
  if (role === "member") {
    return "viewer";
  }
  return role === "owner" || role === "admin" || role === "viewer" ? role : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
