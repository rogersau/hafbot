import { createFileRoute } from "@tanstack/react-router";

import { createLazyAdminPage } from "../../../../admin/routes/lazy-page";
import { AdminRouteShell, useAdminRouteContext } from "../../../../admin/routes/page-context";
import type { AdminRouterContext } from "../../../../admin/routes/context";
import { useRouteInvalidation } from "../../../../admin/hooks/use-route-invalidation";
import { loadProfileRoute } from "../../../../admin/lib/admin-route-loaders";
import { AdminRouteError } from "../../../../admin/components/admin-route-error";

const AdminUserProfilePage = createLazyAdminPage(
  () => import("../../../../admin/components/user-profile-page"),
  "UserProfilePage",
);

export const Route = createFileRoute("/admin/_dashboard/profile")({
  loader: async (ctx) => {
    const loaderData = await loadProfileRoute(ctx);
    void AdminUserProfilePage.preload().catch(() => undefined);
    return loaderData;
  },
  errorComponent: AdminRouteError,
  component: ProfileRoute,
});

function ProfileRoute() {
  const context = useAdminRouteContext();
  const loaderData = Route.useLoaderData();
  const invalidateRoute = useRouteInvalidation();

  const guilds = loaderData?.data.guilds ?? context.guildDirectory ?? [];

  const applyPatch = async (
    patch: Parameters<typeof context.applyUserPreferencesPatch>[0],
    options?: Parameters<typeof context.applyUserPreferencesPatch>[1],
  ) => {
    await context.applyUserPreferencesPatch(patch, options);
    await invalidateRoute();
  };

  return (
    <AdminRouteShell>
      <AdminUserProfilePage
        preferences={context.userPreferences}
        user={context.userProfile}
        guilds={guilds}
        entitlementLabel={getProfileEntitlementLabel(context)}
        applyUserPreferencesPatch={applyPatch}
      />
    </AdminRouteShell>
  );
}

function getProfileEntitlementLabel(context: AdminRouterContext) {
  if (!context.entitlement) return null;
  return context.entitlement.tier === "premium_plus"
    ? "Premium Plus"
    : context.entitlement.tier === "premium"
      ? "Premium"
      : "Free";
}
