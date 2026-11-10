import { createGuildRoute } from "./guild-route-factory";
import { loadMemberVerificationRoute } from "../../lib/admin-route-loaders";

export const Route = createGuildRoute({
  path: "member-verification",
  loader: loadMemberVerificationRoute,
  page: {
    load: () => import("../../components/admin-member-verification-page"),
    exportName: "AdminMemberVerificationPage",
  },
  extraProps: (context) => ({
    entitlement: context.entitlement,
  }),
});
