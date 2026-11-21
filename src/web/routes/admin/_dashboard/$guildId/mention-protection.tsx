import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadMentionProtectionRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/mention-protection")(
  guildRouteOptions({
    path: "mention-protection",
    loader: loadMentionProtectionRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-mention-protection-page"),
      exportName: "AdminMentionProtectionPage",
    },
    extraProps: (context, loaderData) => ({
      entitlement: context.entitlement ?? loaderData?.data.entitlement ?? null,
    }),
  }),
);
