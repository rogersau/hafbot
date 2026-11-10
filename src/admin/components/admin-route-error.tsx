import type { ErrorComponentProps } from "@tanstack/react-router";
import { useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { describeError } from "../lib/api";
import { AdminErrorNotice } from "./admin-error-notice";
import { Card, CardContent } from "./ui/card";
import { Button } from "./ui/button";
import { AdminRouteShell } from "../routes/page-context";

export function AdminRouteError({ error, reset }: ErrorComponentProps) {
  return (
    <AdminRouteShell>
      <AdminRouteErrorContent error={error} reset={reset} />
    </AdminRouteShell>
  );
}

export function AdminRouteErrorContent({ error, reset }: ErrorComponentProps) {
  const router = useRouter({ warn: false });
  const [retrying, setRetrying] = useState(false);
  const message = describeError(error);
  const requiresDiscordSignIn = message.includes("sign out and sign back in with Discord");
  const pathname = router?.state.location.pathname ?? "/admin";
  const guildMatch = pathname.match(/^\/admin\/([^/]+)(?:\/|$)/);
  const guildId = guildMatch?.[1];
  const troubleshootingHref =
    guildId && !["profile", "workspaces", "billing"].includes(guildId)
      ? `/admin/${guildId}/troubleshooting`
      : "https://docs.hafbot.xyz/admin-dashboard#troubleshooting-page";

  async function retryRoute() {
    if (!router || retrying) return;
    setRetrying(true);
    try {
      await retryAdminRoute(router, reset);
    } finally {
      setRetrying(false);
    }
  }

  return (
    <Card>
      <CardContent className="pt-6">
        <AdminErrorNotice error={error} />
        <div className="mt-4 flex flex-wrap gap-2">
          {requiresDiscordSignIn ? (
            <form method="post" action="/admin/logout">
              <Button type="submit">Sign out and reconnect Discord</Button>
            </form>
          ) : (
            <Button type="button" loading={retrying} onClick={() => void retryRoute()}>
              {retrying ? "Retrying" : "Retry"}
            </Button>
          )}
          <Button asChild type="button" variant="outline">
            <a href={troubleshootingHref}>Troubleshooting</a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

export async function retryAdminRoute(
  router: { invalidate: () => Promise<unknown> },
  reset?: () => void,
) {
  await router.invalidate();
  reset?.();
}
