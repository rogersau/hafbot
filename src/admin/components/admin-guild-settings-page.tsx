import { AdminPageHeader } from "./admin-page-header";
import { GuildAdminRoleCard } from "./guild-admin-role-card";
import { NoGuildSelected } from "./no-guild-selected";
import type { GuildSettingsLoaderData } from "../lib/admin-route-loaders";
import { ProductAnalyticsPreferenceCard } from "./product-analytics-preference-card";

export function AdminGuildSettingsPage({
  selectedWorkspaceId,
  selectedGuildId,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  initialData?: GuildSettingsLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const trimmedGuildId = selectedGuildId.trim();

  return (
    <section className="admin-feature-page admin-page-settings space-y-6">
      <AdminPageHeader title="Guild Settings" description="Guild-wide settings for HAFBot." />
      {!trimmedGuildId ? (
        <NoGuildSelected feature="Guild Settings" />
      ) : (
        <div className="space-y-6">
          <GuildAdminRoleCard
            key={trimmedGuildId}
            selectedWorkspaceId={selectedWorkspaceId}
            selectedGuildId={trimmedGuildId}
            initialAdminRoleId={initialData?.adminRoleId ?? null}
            initialManageServerAdminEnabled={initialData?.manageServerAdminEnabled ?? true}
            canManageDelegation={initialData?.canManageDelegation ?? false}
            canManageServerPolicy={initialData?.canManageServerPolicy ?? false}
            onSaved={onRouteDataRefresh}
          />
          <ProductAnalyticsPreferenceCard
            selectedWorkspaceId={selectedWorkspaceId}
            selectedGuildId={trimmedGuildId}
            initialEnabled={initialData?.productAnalyticsEnabled}
            loadError={initialData?.productAnalyticsError}
          />
        </div>
      )}
    </section>
  );
}
