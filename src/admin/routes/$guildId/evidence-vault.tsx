import { createGuildRoute } from "./guild-route-factory";
import { loadEvidenceVaultRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "evidence-vault",
  loader: loadEvidenceVaultRoute,
  page: {
    load: () => import("../../components/admin-evidence-vault-page"),
    exportName: "AdminEvidenceVaultPage",
  },
  extraProps: (context) => ({
    entitlement: context.entitlement,
  }),
});
