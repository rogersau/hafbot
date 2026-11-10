import type { ComponentType } from "react";

import { AdminAuditLogPage } from "../../src/admin/components/admin-audit-log-page";
import { AdminBanCasesPage } from "../../src/admin/components/admin-ban-cases-page";
import { AdminBillingPage } from "../../src/admin/components/admin-billing-page";
import { AdminBlocklistPage } from "../../src/admin/components/admin-blocklist-page";
import { AdminBotDefensePage } from "../../src/admin/components/admin-bot-defense-page";
import { AdminClansPage } from "../../src/admin/components/admin-clans-page";
import { AdminEventsPage } from "../../src/admin/components/admin-events-page";
import { AdminEvidenceVaultPage } from "../../src/admin/components/admin-evidence-vault-page";
import { AdminGuildSettingsPage } from "../../src/admin/components/admin-guild-settings-page";
import { AdminImageRulesPage } from "../../src/admin/components/admin-image-rules-page";
import { AdminLfgPage } from "../../src/admin/components/admin-lfg-page";
import { AdminManagedMessagesPage } from "../../src/admin/components/admin-managed-messages-page";
import { AdminMarketplacePage } from "../../src/admin/components/admin-marketplace-page";
import { AdminMemberVerificationPage } from "../../src/admin/components/admin-member-verification-page";
import { AdminMentionProtectionPage } from "../../src/admin/components/admin-mention-protection-page";
import {
  AdminOverviewPage,
  GuildDirectoryEmptyCard,
} from "../../src/admin/components/admin-overview-page";
import { AdminPlayerCountPage } from "../../src/admin/components/admin-playercount-page";
import { AdminSteamLinkPage } from "../../src/admin/components/admin-steam-link-page";
import { AdminTicketsPageWithHistory } from "../../src/admin/components/admin-tickets-page-with-history";
import { AdminTimedRolesPage } from "../../src/admin/components/admin-timed-roles-page";
import { AdminTroubleshootingPage } from "../../src/admin/components/admin-troubleshooting-page";
import { AdminWebhooksPage } from "../../src/admin/components/admin-webhooks-page";
import { UserProfilePage } from "../../src/admin/components/user-profile-page";
import { setAdminPageTestLoader } from "../../src/admin/routes/lazy-page";

const pages = {
  AdminAuditLogPage,
  AdminBanCasesPage,
  AdminBillingPage,
  AdminBlocklistPage,
  AdminBotDefensePage,
  AdminClansPage,
  AdminEventsPage,
  AdminEvidenceVaultPage,
  AdminGuildSettingsPage,
  AdminImageRulesPage,
  AdminLfgPage,
  AdminManagedMessagesPage,
  AdminMarketplacePage,
  AdminMemberVerificationPage,
  AdminMentionProtectionPage,
  AdminOverviewPage,
  GuildDirectoryEmptyCard,
  AdminPlayerCountPage,
  AdminSteamLinkPage,
  AdminTicketsPageWithHistory,
  AdminTimedRolesPage,
  AdminTroubleshootingPage,
  AdminWebhooksPage,
  UserProfilePage,
};

setAdminPageTestLoader(
  (exportName) =>
    pages[exportName as keyof typeof pages] as ComponentType<Record<string, unknown>> | undefined,
);
