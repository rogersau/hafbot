import { createRoute } from "@tanstack/react-router";

import { Route as rootRoute } from "./__root";
import { createLazyAdminPage } from "./lazy-page";
import { AdminRouteShell, useAdminRouteContext } from "./page-context";
import type { AdminRouterContext } from "./context";
import { useRouteInvalidation } from "../hooks/use-route-invalidation";
import { loadProfileRoute } from "../lib/admin-route-loaders";
import { AdminRouteError } from "../components/admin-route-error";

const AdminUserProfilePage = createLazyAdminPage(
  () => import("../components/user-profile-page"),
  "UserProfilePage",
);

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/profile",
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
