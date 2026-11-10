import { createGuildRoute } from "./$guildId/guild-route-factory";
import { loadGuildOverviewRoute } from "../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "/",
  loader: loadGuildOverviewRoute,
  page: {
    load: () => import("../components/admin-overview-page"),
    exportName: "AdminOverviewPage",
  },
  useKey: false,
  initialData: false,
  extraProps: (context, loaderData) => {
    const entitlement = context.entitlement ?? loaderData?.data?.entitlement ?? null;
    const overview = loaderData?.data?.overview ?? null;
    return {
      tier: entitlement?.tier ?? null,
      r2Usage: entitlement?.r2Usage ?? null,
      cards: overview?.cards ?? [],
      recommendedNextStep: overview?.recommendedNextStep ?? null,
      openIncidents: overview?.operations?.openIncidents ?? [],
      canRemediate: loaderData?.data?.canRemediate ?? false,
    };
  },
});
