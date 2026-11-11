import { AdminApiError } from "./api";
import { AdminContractViolationError } from "../generated/admin-client/core";
import type {
  AdminGuildDirectoryResponse,
  AdminGuildOverviewResponse,
  AdminPermissionDiagnosticsResponse,
  AdminPermissionCheckResponse,
  TicketSetupCheckResponse,
} from "../../runtime/admin-types";
import type { PlatformLink, PlatformLinkConfig } from "../../runtime/contracts/platform-link-store";
import type {
  BanCaseConfig,
  BanCaseSource,
  EvidenceVaultConfig,
  GuildAuditLogConfig,
  ImageRulesConfig,
  BotDefenseConfig,
  LfgConfig,
  LfgPost,
  ManualAssignmentTimedRoleConfig,
  MentionProtectionConfig,
  MarketplaceBusinessLog,
  MarketplaceConfig,
  MarketplacePost,
  MemberVerificationConfig,
  ManagedMessage,
  ManagedMessageDraft,
  MessageTemplate,
  NewMemberTimedRoleConfig,
  ReactionLimitConfig,
  ReactionLimitBreachCounter,
  TicketInstance,
  TicketPanelConfig,
  TimedRoleAssignment,
  EventRecord,
  EventSignup,
  EventTeam,
  EventTeamAuditRecord,
  EventTeamDeliveryOutboxRecord,
  EventTeamMembership,
  EventTeamProposal,
  EventTeamRosterSnapshot,
  EventTemplate,
} from "../../types";
import type { PlayerCountServer } from "../../types/player-count";
import type { Clan, ClanManagementConfig, ClanRequest } from "../../clans";
import type { FeatureSetupState, SetupResourceChoice } from "../../feature-setup";
import type { ConsideredReply, Suggestion, SuggestionsConfig } from "../../suggestions";
import type { CommerceOfferingDashboard } from "../../commerce/offering-service";
import type { CommerceSalesPanel, CommerceSellerProfile } from "../../commerce/types";
import type { CommerceSellerOffboarding } from "../../commerce/financial-operations";
import type { CommerceSafeguardDashboard } from "../../commerce/safeguards";
import type { CommerceSupportPage, CommerceSupportReport } from "../../commerce/support-payments";
import type { CommerceBranding } from "../../commerce/branding";
import { isRecord } from "../../unknown-parse";
import type { EntitlementInfo } from "../hooks/use-entitlement";
import type { GuildResources } from "./guild-resources-cache";
import type { webhookProxyClient } from "../generated/admin-client/webhook-proxy";
import {
  createAdminLoaderClient,
  type AdminLoaderContext,
  type AdminRouteTableRow,
  type LoadedAdminRouteData,
  wrapLoaded,
} from "./admin-loader-client";

export type { AdminLoaderContext, LoadedAdminRouteData };

export interface BlocklistLoaderData {
  blocklist: {
    enabled?: boolean;
    emojis: string[];
    notificationChannelId?: string | null;
    channelMode?: "include" | "exclude";
    channelIds?: string[];
  };
  reactionLimits: {
    config: ReactionLimitConfig | null;
    counters: ReactionLimitBreachCounter[];
  } | null;
  entitlement: EntitlementInfo | null;
}

export interface LfgLoaderData {
  config: LfgConfig;
  posts: LfgPost[];
}

export interface ClansLoaderData {
  guildId: string;
  config: ClanManagementConfig;
  requests: ClanRequest[];
  clans: Clan[];
  setup: FeatureSetupState | null;
  recommendedSetupChoices: Record<string, SetupResourceChoice> | null;
}

export interface SuggestionsLoaderData {
  guildId: string;
  config: SuggestionsConfig;
  suggestions: Suggestion[];
  collapsedReplies: ConsideredReply[];
  readiness: {
    state: "not_configured" | "degraded" | "ready" | "ready_disabled";
    checks: Record<string, boolean>;
  };
}

export interface ManagedMessagesLoaderData {
  guildId: string;
  messages: ManagedMessage[];
  drafts?: ManagedMessageDraft[];
  templates?: MessageTemplate[];
  entitlement: EntitlementInfo | null;
  canWrite: boolean;
  resources: GuildResources;
}

export interface MarketplaceLoaderData {
  config: MarketplaceConfig;
  posts: MarketplacePost[];
  logs: MarketplaceBusinessLog[];
}

export interface CommerceLoaderData {
  guildId: string;
  sellerProfile: CommerceSellerProfile | null;
  dashboard: CommerceOfferingDashboard | null;
  support: CommerceSupportPage | null;
  supportReport: CommerceSupportReport[];
  branding?: CommerceBranding | null;
  offboarding?: CommerceSellerOffboarding | null;
  safeguards?: CommerceSafeguardDashboard | null;
  salesPanel?: CommerceSalesPanel | null;
  panelChannels?: Array<{ id: string; name: string }>;
  manageableRoles: Array<{ id: string; name: string }>;
  currentTermsVersion: string;
  activeOfferingLimit: number;
  stripeDashboardAvailable: boolean;
  sellerOnboardingAvailable?: boolean;
  sellerOwner?: boolean;
  sellerSuggestedSupportContact?: string;
}

export interface EventsLoaderData {
  recurrences?: import("../../event-recurrence").EventRecurrenceSummary[];
  guildId: string;
  templates: EventTemplate[];
  events: Array<{
    event: EventRecord;
    signups: EventSignup[];
    teams: EventTeam[];
    memberships: EventTeamMembership[];
    proposals: EventTeamProposal[];
    audit: Array<
      Omit<EventTeamAuditRecord, "prior" | "result"> & {
        prior?: unknown;
        result?: unknown;
      }
    >;
    snapshots: EventTeamRosterSnapshot[];
    deliveries: Array<Omit<EventTeamDeliveryOutboxRecord, "payload"> & { payload?: unknown }>;
    integrityWarnings: string[];
    expiredProposalCount: number;
    readiness: Array<{
      teamId: string;
      rosterCount: number;
      confirmedCount: number;
      openPlaces: number;
      ready: boolean;
      reasons: Array<"roster_incomplete" | "member_waitlisted">;
    }>;
  }>;
}

export interface PlayerCountLoaderData {
  wardogs?: {
    enabled: boolean;
    targets: { id: string; name: string; ready: boolean; reason?: string }[];
  };
  guildId: string;
  servers: PlayerCountServer[];
}

export interface ServerLevelsLoaderData {
  config: {
    guildId: string;
    enabled: boolean;
    announcementChannelId: string | null;
    removedAtMs: number | null;
    updatedAtMs: number;
  } | null;
  servers: Array<{
    id: string;
    displayName: string;
    providerServerId: string;
    maxSlots: number;
    webhookUrl: string;
    webhookVerifiedAtMs: number | null;
    subscribedEvents: string[];
    capacityProposal: { maxSlots: number; observedAtMs: number } | null;
    dataApiConfigured: boolean;
    lastRosterReconciledAtMs: number | null;
    lastCapacityCheckedAtMs: number | null;
    createdAtMs: number;
    updatedAtMs: number;
  }>;
  beta: true;
  maxServers: number;
  requiredEvents: string[];
  steamLinkConfigured: boolean;
  credentialEncryptionAvailable: boolean;
  processingAvailable: boolean;
}

export interface PlayerLinkLoaderData {
  guildId: string;
  platform: "steam" | "xbox" | "playstation";
  config: PlatformLinkConfig | null;
  links: PlatformLink[];
}

export interface EvidenceVaultLoaderData {
  guildId: string;
  config: EvidenceVaultConfig | null;
  enumValueUsage: Record<string, Record<string, number>>;
  recordUsage: { used: number; max: number | null };
  entitlement: EntitlementInfo | null;
}

export interface GuildAuditLogLoaderData {
  guildId: string;
  config: GuildAuditLogConfig | null;
  entitlement: EntitlementInfo | null;
  canWrite: boolean;
}

export interface ImageRulesLoaderData {
  guildId: string;
  config: ImageRulesConfig | null;
  entitlement: EntitlementInfo | null;
}

export interface BotDefenseLoaderData {
  guildId: string;
  config: BotDefenseConfig | null;
  entitlement: EntitlementInfo | null;
}

export interface MentionProtectionLoaderData {
  guildId: string;
  config: MentionProtectionConfig | null;
  entitlement: EntitlementInfo | null;
  setupChecks: AdminPermissionCheckResponse["checks"];
}

export interface MemberVerificationLoaderData {
  guildId: string;
  config: MemberVerificationConfig | null;
  entitlement: EntitlementInfo | null;
  paidMethodsAvailable: boolean;
  turnstileAvailable: boolean;
  steamLinkAvailable: boolean;
  steamLinkConfigured: boolean;
}

export interface TimedRolesLoaderData {
  assignments: TimedRoleAssignment[];
  notificationChannelId?: string | null;
  newMemberRoleConfig?: NewMemberTimedRoleConfig;
  manualAssignmentRoleConfig?: ManualAssignmentTimedRoleConfig;
}

export interface ClosedTicketsPage {
  tickets: TicketInstance[];
  total: number;
  nextCursor: number | null;
}

export interface TicketsLoaderData {
  resources: GuildResources;
  panel: TicketPanelConfig;
  panels: TicketPanelConfig[];
  closedTicketsPage: ClosedTicketsPage;
  setupCheck: TicketSetupCheckResponse;
}

export interface WebhooksLoaderData {
  guildId: string;
  configs: Awaited<ReturnType<typeof webhookProxyClient.get>>["configs"];
}

export interface GuildOverviewLoaderData {
  entitlement: EntitlementInfo | null;
  overview: AdminGuildOverviewResponse | null;
  canRemediate?: boolean;
}

export interface GuildShellLoaderData {
  guildId: string;
  workspaceId: string;
  entitlement: EntitlementInfo | null;
}

export interface GuildSettingsLoaderData {
  adminRoleId: string | null;
  manageServerAdminEnabled?: boolean;
  canManageDelegation?: boolean;
  canManageServerPolicy?: boolean;
  productAnalyticsEnabled?: boolean;
  productAnalyticsError?: unknown;
}

export async function loadGuildShellRoute(ctx: AdminLoaderContext) {
  return wrapLoaded<GuildShellLoaderData>({
    guildId: getGuildId(ctx),
    workspaceId: getWorkspaceId(ctx),
    entitlement: await loadOptionalEntitlementWithoutParent(ctx, getGuildId(ctx)),
  });
}

export async function loadGuildOverviewRoute(ctx: AdminLoaderContext) {
  const guildId = getGuildId(ctx);
  if (!guildId)
    return wrapLoaded<GuildOverviewLoaderData>({
      entitlement: null,
      overview: null,
    });
  const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");

  const [entitlement, overview, capability] = await Promise.all([
    loadOptionalEntitlement(ctx, guildId),
    crossCuttingClient
      .guildOverview({ workspaceId: getWorkspaceId(ctx) || undefined, guildId })
      .then((value) => value as AdminGuildOverviewResponse),
    client(ctx)
      .getJson<{ canWrite: boolean }>("/admin/api/operations/incidents/capabilities", {
        workspaceId: getWorkspaceId(ctx),
        guildId,
      })
      .catch(() => ({ canWrite: false })),
  ]);

  return wrapLoaded<GuildOverviewLoaderData>({
    entitlement,
    overview,
    canRemediate: capability.canWrite,
  });
}

export async function loadGuildSettingsRoute(ctx: AdminLoaderContext) {
  const guildId = getGuildId(ctx);
  const workspaceId = getWorkspaceId(ctx);
  if (!guildId)
    return wrapLoaded<GuildSettingsLoaderData>({
      adminRoleId: null,
      productAnalyticsEnabled: true,
    });
  const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");

  const [access, preference] = await Promise.all([
    crossCuttingClient.guildAdminRole({
      workspaceId: workspaceId || undefined,
      guildId,
    }),
    crossCuttingClient
      .productAnalyticsPreference({ workspaceId: workspaceId || undefined, guildId })
      .then((value) => ({ enabled: value.enabled, error: undefined as unknown }))
      .catch((error: unknown) => {
        if (
          (error instanceof AdminApiError || error instanceof AdminContractViolationError) &&
          (error.status === 401 || error.status === 403)
        ) {
          throw error;
        }
        return { enabled: undefined, error };
      }),
  ]);

  return wrapLoaded<GuildSettingsLoaderData>({
    ...access,
    adminRoleId: access.adminRoleId ?? null,
    productAnalyticsEnabled: preference.enabled,
    productAnalyticsError: preference.error,
  });
}

export async function loadBlocklistRoute(ctx: AdminLoaderContext) {
  const guildId = getGuildId(ctx);
  const entitlement = await loadOptionalEntitlement(ctx, guildId);
  const [blocklist, reactionLimits] = await Promise.all([
    client(ctx).getJson<BlocklistLoaderData["blocklist"]>("/admin/api/blocklist", {
      workspaceId: getWorkspaceId(ctx),
      guildId,
    }),
    client(ctx).getJson<NonNullable<BlocklistLoaderData["reactionLimits"]>>(
      "/admin/api/reaction-limits",
      { workspaceId: getWorkspaceId(ctx), guildId },
    ),
  ]);

  return wrapLoaded<BlocklistLoaderData>({
    blocklist,
    reactionLimits,
    entitlement,
  });
}

const lfgRoute: AdminRouteTableRow<LfgLoaderData> = {
  path: "/admin/api/lfg",
};

export const loadLfgRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute(lfgRoute, ctx, loadOptionalEntitlement);

const clansRoute: AdminRouteTableRow<ClansLoaderData> = {
  path: "/admin/api/clans",
};

export const loadClansRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute(clansRoute, ctx, loadOptionalEntitlement);

const suggestionsRoute: AdminRouteTableRow<SuggestionsLoaderData> = {
  path: "/admin/api/suggestions",
};

export const loadSuggestionsRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute(suggestionsRoute, ctx, loadOptionalEntitlement);

const marketplaceRoute: AdminRouteTableRow<MarketplaceLoaderData> = {
  path: "/admin/api/marketplace",
};

export const loadMarketplaceRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute(marketplaceRoute, ctx, loadOptionalEntitlement);

const commerceRoute: AdminRouteTableRow<CommerceLoaderData> = {
  path: "/admin/api/commerce",
};

export const loadCommerceRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute(commerceRoute, ctx, loadOptionalEntitlement);

export async function loadEventsRoute(ctx: AdminLoaderContext) {
  const { eventsClient } = await import("../generated/admin-client/events");
  const data = await eventsClient.get(
    { workspaceId: getWorkspaceId(ctx) || undefined, guildId: getGuildId(ctx) },
    ctx.abortController?.signal,
  );
  return wrapLoaded<EventsLoaderData>(data);
}

export async function loadPlayerCountRoute(ctx: AdminLoaderContext) {
  const { playerCountClient } = await import("../generated/admin-client/player-count");
  const data = await playerCountClient.get(
    { workspaceId: getWorkspaceId(ctx) || undefined, guildId: getGuildId(ctx) },
    ctx.abortController?.signal,
  );
  return wrapLoaded<PlayerCountLoaderData>(data);
}

const serverLevelsRoute: AdminRouteTableRow<ServerLevelsLoaderData> = {
  path: "/admin/api/server-levels",
  entitlementGate: "return-null-on-free",
  freeTierFallback: () => ({
    config: null,
    servers: [],
    beta: true,
    maxServers: 5,
    requiredEvents: ["user.join", "user.leave", "server.restart", "server.shutdown"],
    steamLinkConfigured: false,
    credentialEncryptionAvailable: false,
    processingAvailable: false,
  }),
};

export const loadServerLevelsRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute(serverLevelsRoute, ctx, loadOptionalEntitlement);

export const loadReactionRolesRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute<{
    panel: import("../../reaction-roles").ReactionRolePanel | null;
    panels?: import("../../reaction-roles").ReactionRolePanel[];
  }>({ path: "/admin/api/reaction-roles" }, ctx, loadOptionalEntitlement);

export const loadPlayerLinkRoute = async (ctx: AdminLoaderContext) => {
  const { playerLinkClient } = await import("../generated/admin-client/player-link");
  const data = await playerLinkClient.get(
    {
      workspaceId: getWorkspaceId(ctx) || undefined,
      guildId: getGuildId(ctx),
      platform: resolvePlayerLinkPlatform(ctx),
    },
    ctx.abortController?.signal,
  );
  return wrapLoaded<PlayerLinkLoaderData>(data);
};

function communityPageLoader<T>(path: string) {
  return (ctx: AdminLoaderContext) =>
    client(ctx).loadRoute<T>({ path }, ctx, loadOptionalEntitlement);
}
export const loadAutomationRoute = communityPageLoader<
  import("../components/admin-community-tools-page").CommunityToolsLoaderData
>("/admin/api/community-automation");
export const loadChatModerationRoute = communityPageLoader<
  import("../components/admin-community-tools-page").CommunityToolsLoaderData
>("/admin/api/community-moderation");
export const loadContentFeedsRoute = communityPageLoader<
  import("../components/admin-community-tools-page").CommunityToolsLoaderData
>("/admin/api/community-feeds");
export const loadReputationRoute =
  communityPageLoader<import("../components/admin-reputation-page").ReputationLoaderData>(
    "/admin/api/reputation",
  );

const evidenceVaultRoute: AdminRouteTableRow<
  Omit<EvidenceVaultLoaderData, "entitlement">,
  EvidenceVaultLoaderData
> = {
  path: "/admin/api/evidence-vault",
  entitlementGate: "attach",
  transform: (data, _ctx, entitlement) => ({ ...data, entitlement }),
};

export const loadEvidenceVaultRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute(evidenceVaultRoute, ctx, loadOptionalEntitlement);

const guildAuditLogRoute: AdminRouteTableRow<
  Omit<GuildAuditLogLoaderData, "entitlement" | "canWrite">,
  Omit<GuildAuditLogLoaderData, "canWrite">
> = {
  path: "/admin/api/guild-audit-log",
  entitlementGate: "attach",
  transform: (data, _ctx, entitlement) => ({ ...data, entitlement }),
};

export const loadGuildAuditLogRoute = (ctx: AdminLoaderContext) =>
  Promise.all([
    client(ctx).loadRoute(guildAuditLogRoute, ctx, loadOptionalEntitlement),
    client(ctx)
      .getJson<{ canWrite: boolean }>("/admin/api/guild-audit-log/capabilities", guildQuery(ctx))
      .then((data) => data.canWrite === true)
      .catch(() => false),
  ]).then(([loaded, canWrite]) => ({
    ...loaded,
    data: { ...loaded.data, canWrite },
  }));

export async function loadManagedMessagesRoute(ctx: AdminLoaderContext) {
  const { managedMessagesClient } = await import("../generated/admin-client/managed-messages");
  const workspaceId = getWorkspaceId(ctx);
  const guildId = getGuildId(ctx);
  const query = { workspaceId: workspaceId || undefined, guildId };
  const signal = ctx.abortController?.signal;
  const [data, entitlement, resources, canWrite, templateData] = await Promise.all([
    managedMessagesClient.list(query, signal),
    loadOptionalEntitlement(ctx, guildId),
    managedMessagesClient.resources(query, signal),
    managedMessagesClient
      .capabilities(query, signal)
      .then((data) => data.canWrite === true)
      .catch(() => false),
    managedMessagesClient.listTemplates(query, signal).catch(() => ({ templates: [] })),
  ]);
  return {
    loadedAt: Date.now(),
    data: {
      ...data,
      entitlement,
      templates: templateData.templates,
      canWrite,
      resources,
    },
  };
}

const imageRulesRoute: AdminRouteTableRow<
  Omit<ImageRulesLoaderData, "entitlement">,
  ImageRulesLoaderData
> = {
  path: "/admin/api/image-rules",
  entitlementGate: "return-null-on-free",
  freeTierFallback: buildFreeTierImageRulesFallback,
  transform: (data, _ctx, entitlement) => ({ ...data, entitlement }),
};

function buildFreeTierImageRulesFallback(
  ctx: AdminLoaderContext,
  entitlement: EntitlementInfo | null,
): ImageRulesLoaderData {
  return {
    guildId: getGuildId(ctx),
    config: null,
    entitlement,
  };
}

export const loadImageRulesRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute(imageRulesRoute, ctx, loadOptionalEntitlement);

const botDefenseRoute: AdminRouteTableRow<
  Omit<BotDefenseLoaderData, "entitlement">,
  BotDefenseLoaderData
> = {
  path: "/admin/api/bot-defense",
  entitlementGate: "return-null-on-free",
  freeTierFallback: buildFreeTierBotDefenseFallback,
  transform: (data, _ctx, entitlement) => ({ ...data, entitlement }),
};

function buildFreeTierBotDefenseFallback(
  ctx: AdminLoaderContext,
  entitlement: EntitlementInfo | null,
): BotDefenseLoaderData {
  return {
    guildId: getGuildId(ctx),
    config: null,
    entitlement,
  };
}

export const loadBotDefenseRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute(botDefenseRoute, ctx, loadOptionalEntitlement);

function buildMentionProtectionFallback(
  ctx: AdminLoaderContext,
  entitlement: EntitlementInfo | null,
): MentionProtectionLoaderData {
  return {
    guildId: getGuildId(ctx),
    config: null,
    entitlement,
    setupChecks: [],
  };
}

export async function loadMentionProtectionRoute(ctx: AdminLoaderContext) {
  const guildId = getGuildId(ctx);
  const entitlement = await loadOptionalEntitlement(ctx, guildId);
  if (!guildId) {
    return wrapLoaded(buildMentionProtectionFallback(ctx, entitlement));
  }
  const [data, permissions] = await Promise.all([
    client(ctx).getJson<Omit<MentionProtectionLoaderData, "entitlement" | "setupChecks">>(
      "/admin/api/mention-protection",
      {
        workspaceId: getWorkspaceId(ctx),
        guildId,
      },
    ),
    client(ctx)
      .getJson<AdminPermissionCheckResponse>("/admin/api/permissions?feature=mention-protection", {
        workspaceId: getWorkspaceId(ctx),
        guildId,
      })
      .catch(() => ({
        guildId,
        feature: "mention-protection" as const,
        checks: [
          {
            id: "mention-protection-discord-setup-unavailable",
            label: "Discord setup checks",
            status: "warning" as const,
            detail:
              "Current Discord permissions could not be loaded. Refresh before enabling enforcement.",
          },
        ],
      })),
  ]);
  return wrapLoaded<MentionProtectionLoaderData>({
    ...data,
    entitlement,
    setupChecks: permissions.checks,
  });
}

const memberVerificationRoute: AdminRouteTableRow<
  Omit<MemberVerificationLoaderData, "entitlement">,
  MemberVerificationLoaderData
> = {
  path: "/admin/api/member-verification",
  entitlementGate: "attach",
  transform: (data, _ctx, entitlement) => ({
    ...data,
    steamLinkConfigured: data.steamLinkConfigured ?? false,
    entitlement,
  }),
};

export const loadMemberVerificationRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute(memberVerificationRoute, ctx, loadOptionalEntitlement);

const timedRolesRoute: AdminRouteTableRow<TimedRolesLoaderData> = {
  path: "/admin/api/timed-roles",
};

export const loadTimedRolesRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute(timedRolesRoute, ctx, loadOptionalEntitlement);

export async function loadTicketsRoute(ctx: AdminLoaderContext) {
  // Ticket-only fallbacks load with this route instead of expanding the app shell.
  return (await import("./ticket-route-loader")).loadTicketsRoute(ctx);
}

export interface BanCasesLoaderData {
  guildId: string;
  config: BanCaseConfig | null;
  sources: BanCaseSource[];
}

export const loadBanCasesRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute(banCasesRoute, ctx, loadOptionalEntitlement);

const banCasesRoute: AdminRouteTableRow<BanCasesLoaderData, BanCasesLoaderData | null> = {
  path: "/admin/api/ban-cases",
  entitlementGate: "return-null-on-free",
  freeTierFallback: () => null,
};

export async function loadWebhooksRoute(ctx: AdminLoaderContext) {
  const { webhookProxyClient } = await import("../generated/admin-client/webhook-proxy");
  const data = await webhookProxyClient.get(
    { workspaceId: getWorkspaceId(ctx) || undefined, guildId: getGuildId(ctx) },
    ctx.abortController?.signal,
  );
  return wrapLoaded<WebhooksLoaderData>(data);
}

const troubleshootingRoute: AdminRouteTableRow<AdminPermissionDiagnosticsResponse> = {
  path: "/admin/api/permissions/diagnostics",
};

export const loadTroubleshootingRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute(troubleshootingRoute, ctx, loadOptionalEntitlement);

export interface ProfileLoaderData {
  guilds: AdminGuildDirectoryResponse["guilds"] | null;
}

export async function loadProfileRoute(_ctx: AdminLoaderContext) {
  const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
  const directory = await crossCuttingClient.guildDirectory({}).catch(() => null);

  return wrapLoaded<ProfileLoaderData>({
    guilds: directory?.guilds ?? null,
  });
}

async function loadEntitlement(ctx: AdminLoaderContext, guildId: string) {
  if (!guildId.trim()) return null;
  const { crossCuttingClient } = await import("../generated/admin-client/cross-cutting");
  return crossCuttingClient.entitlement({
    workspaceId: getWorkspaceId(ctx) || undefined,
    guildId,
  });
}

async function loadOptionalEntitlement(ctx: AdminLoaderContext, guildId: string) {
  try {
    const parentEntitlement = await loadParentEntitlement(ctx, guildId);
    if (parentEntitlement.found) return parentEntitlement.value;
    return await loadEntitlement(ctx, guildId);
  } catch {
    return null;
  }
}

async function loadOptionalEntitlementWithoutParent(ctx: AdminLoaderContext, guildId: string) {
  try {
    return await loadEntitlement(ctx, guildId);
  } catch {
    return null;
  }
}

async function loadParentEntitlement(
  ctx: AdminLoaderContext,
  guildId: string,
): Promise<{ found: boolean; value: EntitlementInfo | null }> {
  if (!ctx.parentMatchPromise) return { found: false, value: null };
  const parentMatch = await ctx.parentMatchPromise;
  const loaderData = parentMatch.loaderData;
  if (!isRecord(loaderData)) return { found: false, value: null };
  const data = loaderData.data;
  if (!isRecord(data) || !Object.hasOwn(data, "entitlement")) {
    return { found: false, value: null };
  }
  const shellData = data as { guildId?: unknown; workspaceId?: unknown };
  if (shellData.guildId !== guildId || shellData.workspaceId !== getWorkspaceId(ctx)) {
    return { found: false, value: null };
  }
  return {
    found: true,
    value: (data as { entitlement?: EntitlementInfo | null }).entitlement ?? null,
  };
}

function client(ctx: AdminLoaderContext) {
  return createAdminLoaderClient(ctx.abortController?.signal);
}

function guildQuery(ctx: AdminLoaderContext) {
  return { workspaceId: getWorkspaceId(ctx), guildId: getGuildId(ctx) };
}

function getGuildId(ctx: AdminLoaderContext) {
  return (ctx.params?.guildId ?? "").trim();
}

function getWorkspaceId(ctx: AdminLoaderContext) {
  return new URLSearchParams(ctx.location?.searchStr ?? "").get("workspaceId")?.trim() ?? "";
}

function resolvePlayerLinkPlatform(ctx: AdminLoaderContext): "steam" | "xbox" | "playstation" {
  const depsPlatform = (ctx.deps as { platform?: unknown } | undefined)?.platform;
  if (depsPlatform === "xbox" || depsPlatform === "steam" || depsPlatform === "playstation") {
    return depsPlatform;
  }
  const searchPlatform = new URLSearchParams(ctx.location?.searchStr ?? "").get("platform");
  return searchPlatform === "xbox" || searchPlatform === "playstation" ? searchPlatform : "steam";
}

export const loadWardogsRoute = (ctx: AdminLoaderContext) =>
  client(ctx).loadRoute<import("../components/admin-wardogs-page").WardogsLoaderData>(
    { path: "/admin/api/wardogs" },
    ctx,
    loadOptionalEntitlement,
  );
