import { createFileRoute } from "@tanstack/react-router";
import { guildRouteOptions } from "../../../../../admin/routes/guild-route-options";
import { loadEvidenceVaultRoute } from "../../../../../admin/lib/admin-route-loaders";

export const Route = createFileRoute("/admin/_dashboard/$guildId/evidence-vault")(
  guildRouteOptions({
    path: "evidence-vault",
    loader: loadEvidenceVaultRoute,
    page: {
      load: () => import("../../../../../admin/components/admin-evidence-vault-page"),
      exportName: "AdminEvidenceVaultPage",
    },
    extraProps: (context) => ({
      entitlement: context.entitlement,
    }),
  }),
);
