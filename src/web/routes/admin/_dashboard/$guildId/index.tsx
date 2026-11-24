import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadGuildOverviewRoute } from "../../../../../admin/lib/admin-route-loaders";
import { readFirstWorkflowId } from "../../../../../first-workflow-intent";

export const Route = createFileRoute("/admin/_dashboard/$guildId/")(
  guildRouteOptions({
    path: "/",
    loader: loadGuildOverviewRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-overview-page"),
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
        firstWorkflowId: readFirstWorkflowId(context.currentSearch),
      };
    },
  }),
);
