import type { GuildEntitlementTier, TicketPanelConfig } from "../types";
import type { FeatureReadiness } from "../feature-setup";
import type { WorkspaceEntitlement, WorkspaceGuildLink, WorkspaceSummary } from "./workspace-types";
import type { OperationalIncidentView } from "../operations/incidents";

export type AdminGuildOverviewCardStatus =
  | "attention"
  | "configured"
  | "not-set-up"
  | "requires-paid-plan";

export interface AdminGuildOverviewCard {
  id: string;
  label: string;
  path: string;
  status: AdminGuildOverviewCardStatus;
  detail: string | null;
  locked: boolean;
  setupHref?: string | null;
  readiness?: FeatureReadiness;
  attentionCount?: number;
  highestSeverity?: "warning" | "error" | "critical";
  attentionSummary?: string | null;
}

export interface RecommendedNextStep {
  featureId: string;
  title: string;
  description: string;
  ctaHref: string;
}

export interface AdminGuildOverviewResponse {
  guildId: string;
  tier: GuildEntitlementTier;
  cards: AdminGuildOverviewCard[];
  recommendedNextStep?: RecommendedNextStep | null;
  operations?: {
    openIncidents: OperationalIncidentView[];
  };
}

export interface AppConfigMutation {
  key: string;
  value: string;
}

export interface AdminGuildDirectoryEntry {
  guildId: string;
  name: string;
  label: string;
  icon: string | null;
}

export interface AdminGuildDirectoryResponse {
  guilds: AdminGuildDirectoryEntry[];
}

export type AdminPremiumClaimStatus = "claimable" | "claimed-by-you" | "claimed-by-another";

export interface AdminPremiumClaimGuild {
  guildId: string;
  name: string;
  icon: string | null;
  isOwner: boolean;
  canManage: boolean;
  entitlementTier: GuildEntitlementTier;
  claimStatus: AdminPremiumClaimStatus;
  claimedByUserId: string | null;
}

export interface AdminPremiumGuildsResponse {
  guilds: AdminPremiumClaimGuild[];
}

export type AdminPermissionFeature =
  | "blocklist"
  | "timed-roles"
  | "tickets"
  | "marketplace"
  | "lfg"
  | "player-count"
  | "wardogs"
  | "server-levels"
  | "steam-link"
  | "evidence-vault"
  | "mention-protection"
  | "managed-messages"
  | "member-verification"
  | "image-rules"
  | "bot-defense"
  | "player-link"
  | "events"
  | "guild-audit-log"
  | "webhooks"
  | "ban-cases";

export type AdminPermissionCheckStatus = "ok" | "warning" | "error";

export interface AdminPermissionCheck {
  id: string;
  label: string;
  status: AdminPermissionCheckStatus;
  detail: string;
  remediation?: string;
}

export interface AdminPermissionCheckResponse {
  guildId: string;
  feature: AdminPermissionFeature;
  checks: AdminPermissionCheck[];
}

export interface AdminPermissionDiagnosticsResponse {
  guildId: string;
  checksByFeature: Partial<Record<AdminPermissionFeature, AdminPermissionCheck[]>>;
}

export type TicketSetupCheckStatus = "ok" | "warning" | "error";

export interface TicketSetupCheck {
  id: string;
  label: string;
  status: TicketSetupCheckStatus;
  detail: string;
}

export type TicketTestAction = "panel-post" | "transcript-upload" | "ai-summary";

export interface TicketSetupCheckResponse {
  guildId: string;
  panelId: string | null;
  overallStatus: TicketSetupCheckStatus;
  checks: TicketSetupCheck[];
  testActions: Array<{
    action: TicketTestAction;
    label: string;
    enabled: boolean;
    reason: string | null;
  }>;
}

export interface TicketTestActionResponse {
  ok: boolean;
  action: TicketTestAction;
  status: "success" | "skipped" | "failed";
  message: string;
}

export interface AdminGuildAdminRoleResponse {
  guildId: string;
  adminRoleId: string | null;
}

export interface AdminGuildAdminRoleMutation {
  guildId: string;
  adminRoleId: string | null;
}

export type TicketPanelConfigPayload = TicketPanelConfig;

export type TicketPanelConfigResource = TicketPanelConfig;

export interface GuildTicketResourceSummary {
  guildId: string;
  ticketPanelConfig: TicketPanelConfigResource | null;
  openTicketCount: number;
}

export interface AdminWorkspaceListResponse {
  workspaces: WorkspaceSummary[];
}

export interface AdminWorkspaceGuildsResponse {
  workspaceId: string;
  guilds: WorkspaceGuildLink[];
}

export interface AdminWorkspaceEntitlementResponse {
  entitlement: WorkspaceEntitlement;
}

export type UserPreferencesTheme = "system" | "light" | "dark";

export type UserPreferencesLanguage = "en" | "es" | "de" | "fr";

export interface UserPreferences {
  hiddenGuildIds: string[];
  defaultGuildId: string | null;
  emailNotifications: boolean;
  pushNotifications: boolean;
  theme: UserPreferencesTheme;
  language: UserPreferencesLanguage;
}

export type UserPreferencesPatch = Partial<UserPreferences>;

export const USER_PREFERENCES_THEMES: readonly UserPreferencesTheme[] = ["system", "light", "dark"];

export const USER_PREFERENCES_LANGUAGES: readonly UserPreferencesLanguage[] = [
  "en",
  "es",
  "de",
  "fr",
];

export const DEFAULT_USER_PREFERENCES: UserPreferences = {
  hiddenGuildIds: [],
  defaultGuildId: null,
  emailNotifications: true,
  pushNotifications: false,
  theme: "system",
  language: "en",
};
