import type { GatewayEventDependencies } from "../../src/runtime/gateway-events/capabilities";
import { createSqliteObservationStore } from "./sqlite/observation-store";
import { createGatewayCommerceLifecycle } from "../../src/runtime/gateway-commerce-lifecycle";
import { SqlitePaidRoleStore } from "./sqlite/runtime/commerce/sqlite-paid-role-store";
import { createSqlitePaidRoleRuntime } from "./sqlite/runtime/commerce/sqlite-paid-role-runtime";
import { createGatewayReactionStore } from "./sqlite/runtime/gateway-reaction-store";

import { createSqliteBotDefenseStore } from "./sqlite/runtime/sqlite-bot-defense-store";
import { createSqliteImageRulesStore } from "./sqlite/runtime/sqlite-image-rules-store";

import type { Env } from "./test-env";

import { createSqliteWhiteLabelBotStore } from "./sqlite/runtime/sqlite-white-label-bot-store";
import { createSqliteBlocklistStore } from "./sqlite/runtime/sqlite-blocklist-store";
import { createSqliteGuildAuditLogStore } from "./sqlite/runtime/sqlite-guild-audit-log-store";
import { createSqliteGuildEntitlementStore } from "./sqlite/runtime/sqlite-guild-entitlement-store";
import { createSqliteGuildRbacStore } from "./sqlite/runtime/sqlite-guild-rbac-store";
import { createSqliteGuildServiceSuspensionStore } from "./sqlite/runtime/sqlite-guild-service-suspension-store";
import { createSqliteKnownGuildStore } from "./sqlite/runtime/sqlite-known-guild-store";
import { createSqliteProductAnalyticsPreferenceStore } from "./sqlite/runtime/sqlite-product-analytics-preference-store";
import { createSqliteLfgStore } from "./sqlite/runtime/sqlite-lfg-store";
import { createSqliteClanStore } from "./sqlite/runtime/sqlite-clan-store";
import { createSqliteManagedMessageStore } from "./sqlite/runtime/sqlite-managed-message-store";
import { createSqliteMemberVerificationStore } from "./sqlite/runtime/sqlite-member-verification-store";
import { createSqliteMentionProtectionStore } from "./sqlite/runtime/sqlite-mention-protection-store";
import { createSqlitePlatformLinkStore } from "./sqlite/runtime/sqlite-platform-link-store";
import { createSqliteReactionLimitStore } from "./sqlite/runtime/sqlite-reaction-limit-store";
import { createSqliteReactionRoleStore } from "./sqlite/runtime/sqlite-reaction-role-store";
import { createSqliteTicketStore } from "./sqlite/runtime/sqlite-ticket-store";
import { createSqliteTimedRoleStore } from "./sqlite/runtime/sqlite-timed-role-store";
import { createSqliteSuggestionStore } from "./sqlite/runtime/sqlite-suggestion-store";
import { createSqliteServerLevelStore } from "./sqlite/runtime/sqlite-server-level-store";
import { createSqliteWebhookCredentialStore } from "./sqlite/security/webhook-credentials/sqlite-store";

import { createGatewayEventOperationStore } from "./sqlite-gateway-operation-store";

export function sqliteGatewayDependencies(env: Env): GatewayEventDependencies {
  const hafDb = env.HAF_DB;
  const whiteLabelStore = createSqliteWhiteLabelBotStore(hafDb);
  const guildServiceSuspensionStore = createSqliteGuildServiceSuspensionStore(hafDb);
  return {
    stores: {
      audit: createSqliteGuildAuditLogStore(hafDb),
      guildServiceSuspensions: guildServiceSuspensionStore!,
      botDefense: createSqliteBotDefenseStore(hafDb),
      imageRules: createSqliteImageRulesStore(hafDb),
      blocklist: createSqliteBlocklistStore(hafDb, env.BOT_USER_ID),
      entitlement: createSqliteGuildEntitlementStore(hafDb, env.HAF_DEPLOYMENT_MODE),
      guildRbac: createSqliteGuildRbacStore(hafDb),
      knownGuild: createSqliteKnownGuildStore(hafDb),
      productAnalyticsPreferences: createSqliteProductAnalyticsPreferenceStore(hafDb),
      lfg: createSqliteLfgStore(hafDb),
      clan: createSqliteClanStore(hafDb),
      managedMessage: createSqliteManagedMessageStore(hafDb),
      memberVerification: createSqliteMemberVerificationStore(hafDb),
      mentionProtection: createSqliteMentionProtectionStore(hafDb),
      platformLink: createSqlitePlatformLinkStore(hafDb),
      reactionLimit: createSqliteReactionLimitStore(hafDb),
      reactionMutations: createGatewayReactionStore(hafDb),
      reactionRole: createSqliteReactionRoleStore(hafDb, {
        guildId: env.HAF_ADMIN_GUILD_ID?.trim(),
        roleIds: [env.HAF_ADMIN_ROLE_ID, env.BILLING_SUPPORT_ROLE_ID],
      }),
      ticket: createSqliteTicketStore(hafDb),
      timedRole: createSqliteTimedRoleStore(hafDb),
      whiteLabel: whiteLabelStore!,
      suggestion: createSqliteSuggestionStore(hafDb),
      serverLevel: createSqliteServerLevelStore(hafDb),
      observations: createSqliteObservationStore(hafDb),
      webhookCredential: createSqliteWebhookCredentialStore(hafDb),
    },
    operationStore: createGatewayEventOperationStore(hafDb),
    commerceLifecycle: createGatewayCommerceLifecycle(
      new SqlitePaidRoleStore(hafDb),
      createSqlitePaidRoleRuntime(env)?.processProviderActions,
    ),
  };
}
