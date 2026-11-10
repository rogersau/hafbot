import { lazy, Suspense } from "react";
import { useNavigate } from "@tanstack/react-router";

import type { EntitlementInfo } from "../hooks/use-entitlement";
import type { TicketsLoaderData } from "../lib/admin-route-loaders";
import { buildTicketsTabHref } from "../lib/admin-route-state";
import { useAdminRouteContext } from "../routes/page-context";
import { refreshAdminRouteData } from "../lib/mutation-reconciliation";
import { AdminPageHeader } from "./admin-page-header";
import { AdminTicketsPage } from "./admin-tickets-page";
import { EmptyState } from "./ui/empty-state";
import { Button } from "./ui/button";
import { UpgradeBanner } from "./upgrade-banner";

const TicketPanelHistory = lazy(() =>
  import("./ticket-panel-history").then((module) => ({ default: module.TicketPanelHistory })),
);

export function AdminTicketsPageWithHistory({
  selectedWorkspaceId,
  selectedGuildId,
  entitlement,
  initialData,
  onRouteDataRefresh,
}: {
  selectedWorkspaceId: string;
  selectedGuildId: string;
  entitlement?: EntitlementInfo | null;
  initialData?: TicketsLoaderData | null;
  onRouteDataRefresh?: () => Promise<void>;
}) {
  const { ticketsTab, currentPath, currentSearch } = useAdminRouteContext();
  const navigate = useNavigate();
  const isPremium = Boolean(entitlement && entitlement.tier !== "free");
  const currentHref = `${currentPath}${currentSearch}`;
  const historyHref = buildTicketsTabHref(currentHref, "history");
  const panelHref = buildTicketsTabHref(currentHref, "panel");

  if (ticketsTab !== "history") {
    return (
      <div className="space-y-3">
        {selectedGuildId.trim() ? (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void navigate({ to: historyHref })}
            >
              Panel history
            </Button>
          </div>
        ) : null}
        <AdminTicketsPage
          selectedWorkspaceId={selectedWorkspaceId}
          selectedGuildId={selectedGuildId}
          entitlement={entitlement}
          initialData={initialData}
          onRouteDataRefresh={onRouteDataRefresh}
        />
      </div>
    );
  }

  return (
    <section className="admin-feature-page admin-page-workflow space-y-6">
      <AdminPageHeader
        title="Ticket Panel history"
        description="Review and restore earlier saved Ticket Panel configurations."
        readinessFeature="tickets"
        selectedGuildId={selectedGuildId}
        selectedWorkspaceId={selectedWorkspaceId}
        actions={
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void navigate({ to: panelHref })}
          >
            Back to Tickets
          </Button>
        }
      />

      {!entitlement ? (
        <EmptyState>Loading subscription details...</EmptyState>
      ) : !isPremium ? (
        <UpgradeBanner
          supportInvite={entitlement.supportInvite ?? null}
          message="Ticket Panel revision history and restore are available on Premium plans."
        />
      ) : !selectedGuildId.trim() ? (
        <EmptyState>Select a server to review its Ticket Panel history.</EmptyState>
      ) : !initialData?.panel ? (
        <EmptyState>Save a Ticket Panel before reviewing its history.</EmptyState>
      ) : (
        <Suspense fallback={<EmptyState>Loading Ticket Panel revision history...</EmptyState>}>
          <TicketPanelHistory
            selectedWorkspaceId={selectedWorkspaceId}
            guildId={selectedGuildId}
            panelId={initialData.panel.panelId ?? "main"}
            onRestored={async () => {
              await refreshAdminRouteData(onRouteDataRefresh);
              void navigate({ to: panelHref });
            }}
          />
        </Suspense>
      )}
    </section>
  );
}
