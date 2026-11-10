import type { RuntimeStores } from "../../src/runtime/app-types";
import { createCloudflareAppConfigStore } from "../../src/runtime/cloudflare-app-config-store";
import { createCloudflareBanCaseStore } from "../../src/runtime/cloudflare-ban-case-store";
import { createCloudflareBlocklistStore } from "../../src/runtime/cloudflare-blocklist-store";
import { createCloudflareBotDefenseStore } from "../../src/runtime/cloudflare-bot-defense-store";
import { createCloudflareClanStore } from "../../src/runtime/cloudflare-clan-store";
import { createCloudflareConfigurationRevisionStore } from "../../src/runtime/cloudflare-configuration-revision-store";
import { createCloudflareEventStore } from "../../src/runtime/cloudflare-event-store";
import { createCloudflareEvidenceVaultStore } from "../../src/runtime/cloudflare-evidence-vault-store";
import { createCloudflareFeatureSetupStore } from "../../src/runtime/cloudflare-feature-setup-store";
import { createCloudflareGuildAuditLogStore } from "../../src/runtime/cloudflare-guild-audit-log-store";
import { createCloudflareGuildEntitlementStore } from "../../src/runtime/cloudflare-guild-entitlement-store";
import { createCloudflareGuildR2ObjectStore } from "../../src/runtime/cloudflare-guild-r2-object-store";
import { createCloudflareGuildRbacStore } from "../../src/runtime/cloudflare-guild-rbac-store";
import { createCloudflareGuildServiceSuspensionStore } from "../../src/runtime/cloudflare-guild-service-suspension-store";
import { createCloudflareImageRulesStore } from "../../src/runtime/cloudflare-image-rules-store";
import { createCloudflareLfgStore } from "../../src/runtime/cloudflare-lfg-store";
import { createCloudflareManagedMessageStore } from "../../src/runtime/cloudflare-managed-message-store";
import { createCloudflareMarketplaceStore } from "../../src/runtime/cloudflare-marketplace-store";
import { createCloudflareMemberVerificationStore } from "../../src/runtime/cloudflare-member-verification-store";
import { createCloudflareMentionProtectionStore } from "../../src/runtime/cloudflare-mention-protection-store";
import { createCloudflareMessageTemplateStore } from "../../src/runtime/cloudflare-message-template-store";
import { createCloudflarePlatformLinkStore } from "../../src/runtime/cloudflare-platform-link-store";
import { createCloudflarePlayerCountStore } from "../../src/runtime/cloudflare-player-count-store";
import { createCloudflareReactionLimitStore } from "../../src/runtime/cloudflare-reaction-limit-store";
import { createCloudflareReactionRoleStore } from "../../src/runtime/cloudflare-reaction-role-store";
import { createCloudflareSuggestionStore } from "../../src/runtime/cloudflare-suggestion-store";
import { createCloudflareAdminFeedbackStore } from "../../src/runtime/cloudflare-admin-feedback-store";
import { createCloudflareTicketStore } from "../../src/runtime/cloudflare-ticket-store";
import { createCloudflareTimedRoleStore } from "../../src/runtime/cloudflare-timed-role-store";
import { createCloudflareUserPreferencesStore } from "../../src/runtime/cloudflare-user-preferences-store";
import { createCloudflareWebhookProxyStore } from "../../src/runtime/cloudflare-webhook-proxy-store";
import { createCloudflareWhiteLabelBotStore } from "../../src/runtime/cloudflare-white-label-bot-store";
import { createCloudflareOneTimeTokenStore } from "../../src/runtime/cloudflare-one-time-token-store";
import { createCloudflareServerLevelStore } from "../../src/runtime/cloudflare-server-level-store";
import type { TestDatabase } from "./sqlite-d1-database";
import { SqliteD1Database } from "./sqlite-d1-database";

export interface ProductionRuntimeStoresFixture {
  readonly database: TestDatabase;
  readonly stores: RuntimeStores;
  close(): void;
}

/**
 * Production-shaped HAF persistence for service and runtime tests.
 *
 * Tests should seed and inspect state through these public stores. A test may
 * wrap one method to inject a failure or observe a true boundary effect, but
 * should not replace a whole HAF-owned store with a Map/array implementation.
 */
export function createProductionRuntimeStores(
  options: {
    botUserId?: string;
    overrides?: Partial<RuntimeStores>;
  } = {},
): ProductionRuntimeStoresFixture {
  const database = new SqliteD1Database();
  const d1 = database.d1;
  const stores: RuntimeStores = {
    blocklist: createCloudflareBlocklistStore(d1, options.botUserId ?? "bot-user-id"),
    appConfig: createCloudflareAppConfigStore(d1),
    timedRoles: createCloudflareTimedRoleStore(d1),
    tickets: createCloudflareTicketStore(d1),
    configurationRevisions: createCloudflareConfigurationRevisionStore(d1),
    marketplace: createCloudflareMarketplaceStore(d1),
    events: createCloudflareEventStore(d1),
    lfg: createCloudflareLfgStore(d1),
    clans: createCloudflareClanStore(d1),
    webhookProxy: createCloudflareWebhookProxyStore(d1),
    playerCount: createCloudflarePlayerCountStore(d1),
    platformLink: createCloudflarePlatformLinkStore(d1),
    guildRbac: createCloudflareGuildRbacStore(d1),
    guildEntitlements: createCloudflareGuildEntitlementStore(d1),
    guildR2Objects: createCloudflareGuildR2ObjectStore(d1),
    reactionLimits: createCloudflareReactionLimitStore(d1),
    reactionRoles: createCloudflareReactionRoleStore(d1),
    evidenceVault: createCloudflareEvidenceVaultStore(d1),
    imageRules: createCloudflareImageRulesStore(d1),
    botDefense: createCloudflareBotDefenseStore(d1),
    mentionProtection: createCloudflareMentionProtectionStore(d1),
    userPreferences: createCloudflareUserPreferencesStore(d1),
    guildAuditLog: createCloudflareGuildAuditLogStore(d1),
    whiteLabelBots: createCloudflareWhiteLabelBotStore(d1),
    banCases: createCloudflareBanCaseStore(d1),
    memberVerification: createCloudflareMemberVerificationStore(d1),
    managedMessages: createCloudflareManagedMessageStore(d1),
    messageTemplates: createCloudflareMessageTemplateStore(d1),
    guildServiceSuspensions: createCloudflareGuildServiceSuspensionStore(d1),
    featureSetup: createCloudflareFeatureSetupStore(d1),
    suggestions: createCloudflareSuggestionStore(d1),
    adminFeedback: createCloudflareAdminFeedbackStore(d1),
    oneTimeTokens: createCloudflareOneTimeTokenStore(d1),
    serverLevels: createCloudflareServerLevelStore(d1),
    ...options.overrides,
  };
  return { database, stores, close: () => database.close() };
}

/** Delegates every method to a production object after asynchronous seeding completes. */
export function afterStoreSeed<T extends object>(target: T, ready: Promise<unknown>): T {
  return new Proxy(target, {
    get(current, property, receiver) {
      const value = Reflect.get(current, property, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        await ready;
        return Reflect.apply(value, current, args);
      };
    },
  });
}

/** Reuses production behavior while overriding only the boundary being observed or failed. */
export function withStoreOverrides<T extends object>(target: T, overrides: Partial<T>): T {
  return new Proxy(target, {
    get(current, property, receiver) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        const override = Reflect.get(overrides, property, receiver);
        return typeof override === "function" ? override.bind(overrides) : override;
      }
      const value = Reflect.get(current, property, receiver);
      return typeof value === "function" ? value.bind(current) : value;
    },
  });
}
