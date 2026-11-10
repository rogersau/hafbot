import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";

import { useAdminRouteContext } from "../routes/page-context";
import { buildAdminDashboardHref } from "../lib/dashboard-urls";

import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { ServerIcon } from "./ui/icons";

export function NoGuildSelected({ description }: { feature: string; description?: ReactNode }) {
  const { selectedWorkspaceId } = useAdminRouteContext();
  const dashboardHref = buildAdminDashboardHref("/admin", selectedWorkspaceId, "");
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 px-6 py-12 text-center">
        <span className="flex h-12 w-12 items-center justify-center rounded-[4px] border bg-muted/40 text-muted-foreground">
          <ServerIcon className="h-5 w-5" />
        </span>
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">Choose a server</p>
          <p className="mx-auto max-w-sm text-xs text-muted-foreground">
            {description ?? "Select a Discord server before managing this feature."}
          </p>
        </div>
        <Button asChild size="sm" variant="outline">
          <Link to={dashboardHref}>Choose server</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
