import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadMemberVerificationRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/member-verification")(
  guildRouteOptions({
    path: "member-verification",
    loader: loadMemberVerificationRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-member-verification-page"),
      exportName: "AdminMemberVerificationPage",
    },
    extraProps: (context) => ({
      entitlement: context.entitlement,
    }),
  }),
);
