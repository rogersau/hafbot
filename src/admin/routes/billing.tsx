import { createRoute } from "@tanstack/react-router";
import { Route as rootRoute } from "./__root";
import { AdminRouteShell } from "./page-context";
import { createLazyAdminPage } from "./lazy-page";

const AdminBillingPage = createLazyAdminPage(
  () => import("../components/admin-billing-page"),
  "AdminBillingPage",
);

export const Route = createRoute({
  getParentRoute: () => rootRoute,
  path: "/admin/billing",
  loader: () => {
    void AdminBillingPage.preload().catch(() => undefined);
  },
  component: () => (
    <AdminRouteShell>
      <AdminBillingPage />
    </AdminRouteShell>
  ),
});
