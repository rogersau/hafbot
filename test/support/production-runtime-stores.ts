import type { RuntimeStores } from "../../src/runtime/app-types";
import { createSqliteAppConfigStore } from "./sqlite/runtime/sqlite-app-config-store";
import { createSqliteBanCaseStore } from "./sqlite/runtime/sqlite-ban-case-store";
import { createSqliteBlocklistStore } from "./sqlite/runtime/sqlite-blocklist-store";
import { createSqliteBotDefenseStore } from "./sqlite/runtime/sqlite-bot-defense-store";
import { createSqliteClanStore } from "./sqlite/runtime/sqlite-clan-store";
import { createSqliteConfigurationRevisionStore } from "./sqlite/runtime/sqlite-configuration-revision-store";
import { createSqliteEventStore } from "./sqlite/runtime/sqlite-event-store";
import { createSqliteEvidenceVaultStore } from "./sqlite/runtime/sqlite-evidence-vault-store";
import { createSqliteFeatureSetupStore } from "./sqlite/runtime/sqlite-feature-setup-store";
import { createSqliteGuildAuditLogStore } from "./sqlite/runtime/sqlite-guild-audit-log-store";
import { createSqliteGuildEntitlementStore } from "./sqlite/runtime/sqlite-guild-entitlement-store";
import { createSqliteGuildR2ObjectStore } from "./sqlite/runtime/sqlite-guild-r2-object-store";
import { createSqliteGuildRbacStore } from "./sqlite/runtime/sqlite-guild-rbac-store";
import { createSqliteGuildServiceSuspensionStore } from "./sqlite/runtime/sqlite-guild-service-suspension-store";
import { createSqliteImageRulesStore } from "./sqlite/runtime/sqlite-image-rules-store";
import { createSqliteLfgStore } from "./sqlite/runtime/sqlite-lfg-store";
import { createSqliteManagedMessageStore } from "./sqlite/runtime/sqlite-managed-message-store";
import { createSqliteMarketplaceStore } from "./sqlite/runtime/sqlite-marketplace-store";
import { createSqliteMemberVerificationStore } from "./sqlite/runtime/sqlite-member-verification-store";
import { createSqliteMentionProtectionStore } from "./sqlite/runtime/sqlite-mention-protection-store";
import { createSqliteMessageTemplateStore } from "./sqlite/runtime/sqlite-message-template-store";
import { createSqlitePlatformLinkStore } from "./sqlite/runtime/sqlite-platform-link-store";
import { createSqlitePlayerCountStore } from "./sqlite/runtime/sqlite-player-count-store";
import { createSqliteReactionLimitStore } from "./sqlite/runtime/sqlite-reaction-limit-store";
import { createSqliteReactionRoleStore } from "./sqlite/runtime/sqlite-reaction-role-store";
import { createSqliteSuggestionStore } from "./sqlite/runtime/sqlite-suggestion-store";
import { createSqliteAdminFeedbackStore } from "./sqlite/runtime/sqlite-admin-feedback-store";
import { createSqliteOperationalIncidentStore } from "./sqlite/runtime/sqlite-operational-incident-store";
import { createSqliteTicketStore } from "./sqlite/runtime/sqlite-ticket-store";
import { createSqliteTimedRoleStore } from "./sqlite/runtime/sqlite-timed-role-store";
import { createSqliteUserPreferencesStore } from "./sqlite/runtime/sqlite-user-preferences-store";
import { createSqliteWebhookProxyStore } from "./sqlite/runtime/sqlite-webhook-proxy-store";
import { createSqliteWhiteLabelBotStore } from "./sqlite/runtime/sqlite-white-label-bot-store";
import { createSqliteOneTimeTokenStore } from "./sqlite/runtime/sqlite-one-time-token-store";
import { createSqliteServerLevelStore } from "./sqlite/runtime/sqlite-server-level-store";
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
    blocklist: createSqliteBlocklistStore(d1, options.botUserId ?? "bot-user-id"),
    appConfig: createSqliteAppConfigStore(d1),
    timedRoles: createSqliteTimedRoleStore(d1),
    tickets: createSqliteTicketStore(d1),
    configurationRevisions: createSqliteConfigurationRevisionStore(d1),
    marketplace: createSqliteMarketplaceStore(d1),
    events: createSqliteEventStore(d1),
    lfg: createSqliteLfgStore(d1),
    clans: createSqliteClanStore(d1),
    webhookProxy: createSqliteWebhookProxyStore(d1),
    playerCount: createSqlitePlayerCountStore(d1),
    platformLink: createSqlitePlatformLinkStore(d1),
    guildRbac: createSqliteGuildRbacStore(d1),
    guildEntitlements: createSqliteGuildEntitlementStore(d1),
    guildR2Objects: createSqliteGuildR2ObjectStore(d1),
    reactionLimits: createSqliteReactionLimitStore(d1),
    reactionRoles: createSqliteReactionRoleStore(d1),
    evidenceVault: createSqliteEvidenceVaultStore(d1),
    imageRules: createSqliteImageRulesStore(d1),
    botDefense: createSqliteBotDefenseStore(d1),
    mentionProtection: createSqliteMentionProtectionStore(d1),
    userPreferences: createSqliteUserPreferencesStore(d1),
    guildAuditLog: createSqliteGuildAuditLogStore(d1),
    whiteLabelBots: createSqliteWhiteLabelBotStore(d1),
    banCases: createSqliteBanCaseStore(d1),
    memberVerification: createSqliteMemberVerificationStore(d1),
    managedMessages: createSqliteManagedMessageStore(d1),
    messageTemplates: createSqliteMessageTemplateStore(d1),
    guildServiceSuspensions: createSqliteGuildServiceSuspensionStore(d1),
    featureSetup: createSqliteFeatureSetupStore(d1),
    suggestions: createSqliteSuggestionStore(d1),
    operationalIncidents: createSqliteOperationalIncidentStore(d1),
    adminFeedback: createSqliteAdminFeedbackStore(d1),
    oneTimeTokens: createSqliteOneTimeTokenStore(d1),
    serverLevels: createSqliteServerLevelStore(d1),
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
