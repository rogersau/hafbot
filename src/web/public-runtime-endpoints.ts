import { DEFAULT_COMMERCE_ACCENT_COLOR, defaultCommerceBranding } from "../commerce/branding";
import { listGuildRoles } from "../discord/guilds";
import { fetchGuildMember } from "../discord/members";
import { createBanAppealPublicEndpoints } from "../moderation-appeals/routes";
import { browserPrivacySignalEnabled, createInsertionId } from "../product-analytics";
import { createAuthRoutes } from "../routes/auth-routes";
import { createCommerceBuyerEndpoints } from "../routes/commerce-buyer-routes";
import { createCommerceSupportEndpoints } from "../routes/commerce-support-routes";
import { createInteractionRoutes } from "../routes/interaction-routes";
import { createMemberVerificationRoutes } from "../routes/member-verification-routes";
import { createPlatformLinkEndpoints } from "../routes/platform-link-routes";
import { report } from "../routes/public-analytics";
import { createPublicEndpoints, type PublicRouteOptions } from "../routes/public-routes";
import { getCachedGuildSummary } from "../runtime/admin-discord-cache";
import type { RuntimeAppOptions } from "../runtime/app-types";
import { readCustomerSession, type CustomerSession } from "../runtime/auth/customer-session";
import { DiscordPaidRoleAdapter } from "../runtime/commerce/discord-paid-role-adapter";
import type { FeatureFlags } from "../runtime/features";
import { handleInteractionRequest } from "../runtime/interaction-handler";
import { createSteamPlatformConfig } from "../services/steam-platform-config";
import { createXboxPlatformConfig } from "../services/xbox-platform-config";

export function createPublicRuntimeEndpoints(
  options: RuntimeAppOptions,
  features: FeatureFlags,
  readCustomerAdminSession: (request: Request) => Promise<CustomerSession | null>,
) {
  const { commerceSupportService, customerAuth, discordBotUserId, services } = options;
  const { banCaseService, platformLinkService, webhookProxyService } = services;
  const readMember = async (guildId: string, discordUserId: string) => {
    const member = await fetchGuildMember(guildId, discordUserId, options.discordBotToken);
    return {
      present: member !== null,
      bot: member?.user?.bot === true,
      banned: false,
    };
  };
  const readBranding = async (guildId: string) => {
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
  };
  const banAppealRoutes =
    options.banAppealServiceForGuild && options.publicUrl
      ? createBanAppealPublicEndpoints({
          serviceForGuild: options.banAppealServiceForGuild,
          readCustomerSession: (request) => readCustomerSession(request, options.customerAuth),
          publicBaseUrl: options.publicUrl,
        })
      : undefined;
  const publicRoutes = createPublicRuntimeResponses({
    selfHostedSite: options.selfHostedSite,
    microsoftApplicationId: options.xboxOAuthClientId,
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
    ? createPlatformLinkEndpoints({
        platformLinkService,
        platformConfig: createSteamPlatformConfig({
          steamWebApiKey: options.steamWebApiKey,
        }),
      })
    : undefined;
  const xboxLinkRoutes =
    features.xboxLink && options.xboxOAuthClientId && options.xboxOAuthClientSecret
      ? createPlatformLinkEndpoints({
          platformLinkService,
          platformConfig: createXboxPlatformConfig({
            clientId: options.xboxOAuthClientId,
            clientSecret: options.xboxOAuthClientSecret,
          }),
        })
      : undefined;
  const memberVerificationRoutes = features.memberVerification
    ? createMemberVerificationRoutes({
        memberVerificationService: services.memberVerificationService,
        customerAuth: options.customerAuth,
        turnstileSiteKey: options.turnstileSiteKey,
        turnstileSecretKey: options.turnstileSecretKey,
      })
    : undefined;
  const commerceBuyerRoutes =
    options.commerceBuyerCheckoutService &&
    options.commercePurchaseSigningSecret &&
    options.publicUrl &&
    customerAuth &&
    discordBotUserId
      ? createCommerceBuyerEndpoints({
          service: options.commerceBuyerCheckoutService,
          signingSecret: options.commercePurchaseSigningSecret,
          publicBaseUrl: options.publicUrl,
          readSession: readCustomerAdminSession,
          readMember,
          roleManageable: async (guildId, discordRoleId, discordUserId) => {
            const adapter = new DiscordPaidRoleAdapter(discordBotUserId, options.discordBotToken);
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
          readBranding,
          readSupportEnabled: commerceSupportService
            ? async (guildId) => (await commerceSupportService.page(guildId)).config.enabled
            : undefined,
        })
      : undefined;
  const authRoutes = customerAuth
    ? createAuthRoutes({
        handle: (request) => customerAuth.handler(request),
        onDiscordSignInCompleted: (request) => {
          if (!options.productAnalytics || browserPrivacySignalEnabled(request)) return;
          report(options, { name: "dashboard_signed_in", insertionId: createInsertionId() });
        },
      })
    : undefined;
  const commerceSupportRoutes =
    commerceSupportService &&
    options.commercePurchaseSigningSecret &&
    options.publicUrl &&
    customerAuth
      ? createCommerceSupportEndpoints({
          service: commerceSupportService,
          signingSecret: options.commercePurchaseSigningSecret,
          publicBaseUrl: options.publicUrl,
          readSession: readCustomerAdminSession,
          readMember,
          readGuildName: async (guildId) =>
            (await getCachedGuildSummary(guildId, options.discordBotToken, false)).name,
          readBranding,
        })
      : undefined;
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
    ...publicRoutes,
    auth: respond(authRoutes),
    banAppealPage: respond(banAppealRoutes?.banAppealPage),
    banAppealScript: respond(banAppealRoutes?.banAppealScript),
    banAppealScriptMethodNotAllowed: respond(banAppealRoutes?.banAppealScriptMethodNotAllowed),
    banAppealMethodNotAllowed: respond(banAppealRoutes?.banAppealMethodNotAllowed),
    banAppealSubmission: respond(banAppealRoutes?.banAppealSubmission),
    billingStripeWebhook: respond(options.billingWebhookHandler),
    commerceBuyerMethodNotAllowed: respond(commerceBuyerRoutes?.methodNotAllowed),
    commerceCheckout: respond(commerceBuyerRoutes?.commerceCheckout),
    commerceOffering: respond(commerceBuyerRoutes?.commerceOffering),
    commercePortal: respond(commerceBuyerRoutes?.commercePortal),
    commerceReturn: respond(commerceBuyerRoutes?.commerceReturn),
    commerceStore: respond(commerceBuyerRoutes?.commerceStore),
    commerceStripeWebhook: respond(options.commerceWebhookHandler),
    commerceSupportMethodNotAllowed: respond(commerceSupportRoutes?.methodNotAllowed),
    commerceSupportCheckout: respond(commerceSupportRoutes?.commerceSupportCheckout),
    commerceSupportPage: respond(commerceSupportRoutes?.commerceSupportPage),
    commerceSupportReturn: respond(commerceSupportRoutes?.commerceSupportReturn),
    interactions: respond(interactionRoutes),
    memberVerificationGet: respond(memberVerificationRoutes?.get),
    memberVerificationPost: respond(memberVerificationRoutes?.post),
    memberVerificationMethodNotAllowed: respond(memberVerificationRoutes?.methodNotAllowed),
    steamLinkStart: respond(steamLinkRoutes?.start),
    steamLinkCallback: respond(steamLinkRoutes?.callback),
    xboxLinkStart: respond(xboxLinkRoutes?.start),
    xboxLinkCallback: respond(xboxLinkRoutes?.callback),
  };
}

export function createPublicRuntimeResponses(options: PublicRouteOptions) {
  const endpoints = createPublicEndpoints(options);
  return {
    ...endpoints,
    evidenceImage: respond(endpoints.evidenceImage),
    managedMedia: respond(endpoints.managedMedia),
    serverLevelIngress: respond(endpoints.serverLevelIngress),
    transcript: respond(endpoints.transcript),
    transcriptMedia: respond(endpoints.transcriptMedia),
  };
}

export type PublicRuntimeEndpoints = ReturnType<typeof createPublicRuntimeEndpoints>;

function respond<Args extends unknown[]>(
  handler?: (...args: Args) => Response | null | Promise<Response | null>,
): (...args: Args) => Promise<Response> {
  return async (...args) =>
    (await handler?.(...args)) ?? new Response("Not found", { status: 404 });
}

function discordGuildIconUrl(guildId: string, icon: string | null | undefined): string | null {
  if (!/^[A-Za-z0-9_-]{2,100}$/.test(guildId) || !icon || !/^[A-Za-z0-9_-]{2,200}$/.test(icon)) {
    return null;
  }
  return `https://cdn.discordapp.com/icons/${encodeURIComponent(guildId)}/${encodeURIComponent(icon)}.png?size=128`;
}
