import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { AdminDashboard } from "../../../admin/components/admin-dashboard";
import { adminDocumentMiddleware } from "../../../admin/routes/document-middleware";
import { Route as guildRoute } from "./_dashboard/$guildId";

export const Route = createFileRoute("/admin/_dashboard")({
  server: { middleware: [adminDocumentMiddleware("dashboard")] },
  ssr: false,
  beforeLoad: ({ context, location }) => {
    const { admin } = context;
    if (!admin?.authenticated) {
      throw redirect({ href: location.href, reloadDocument: true });
    }
    return { admin, dashboardLocation: location };
  },
  component: AdminDashboardLayout,
});

function AdminDashboardLayout() {
  const { admin, dashboardLocation } = Route.useRouteContext();
  return (
    <AdminDashboard admin={admin} guildRouteId={guildRoute.id} location={dashboardLocation}>
      <Outlet />
    </AdminDashboard>
  );
}
