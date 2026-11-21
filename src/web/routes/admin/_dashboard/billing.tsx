import { useCallback } from "react";
import { createFileRoute, useRouter, useRouterState } from "@tanstack/react-router";
import { AdminRouteShell } from "../../../../admin/routes/page-context";
import { createLazyAdminPage } from "../../../../admin/routes/lazy-page";

const AdminBillingPage = createLazyAdminPage(
  () => import("../../../../admin/components/admin-billing-page"),
  "AdminBillingPage",
);

export const Route = createFileRoute("/admin/_dashboard/billing")({
  validateSearch: (search: Record<string, unknown>) => search,
  loaderDeps: ({ search }) => ({ checkoutSessionId: readCheckoutSessionId(search) }),
  loader: {
    staleReloadMode: "blocking",
    async handler({ abortController, deps }) {
      void AdminBillingPage.preload().catch(() => undefined);
      if (deps.checkoutSessionId) return null;
      const { loadBillingRouteData } = await import("../../../../admin/lib/billing-route-data");
      return loadBillingRouteData(abortController.signal);
    },
  },
  pendingMs: 0,
  pendingMinMs: 0,
  pendingComponent: () => (
    <AdminRouteShell>
      <p role="status" className="text-sm text-muted-foreground">
        Loading Billing…
      </p>
    </AdminRouteShell>
  ),
  component: BillingRoute,
});

function readCheckoutSessionId(search: Record<string, unknown>): string | null {
  return search.checkout === "success" && typeof search.session_id === "string"
    ? search.session_id || null
    : null;
}

function BillingRoute() {
  const router = useRouter();
  const navigate = Route.useNavigate();
  const data = Route.useLoaderData();
  const { checkoutSessionId } = Route.useLoaderDeps();
  const search = Route.useSearch();
  const hash = useRouterState({ select: (state) => state.location.hash });
  const committed = useRouterState({
    select: ({ location, resolvedLocation }) =>
      location.href === resolvedLocation?.href &&
      readCheckoutSessionId(location.search) === checkoutSessionId,
  });

  const reload = () =>
    router.invalidate({ filter: (match) => match.routeId === Route.id, sync: true });
  const finishCheckout = useCallback(async () => {
    const location = router.state.location;
    if (
      location.pathname.replace(/\/$/, "") !== Route.fullPath ||
      readCheckoutSessionId(location.search) !== checkoutSessionId
    ) {
      return;
    }

    const search = { ...location.search };
    delete search.checkout;
    delete search.session_id;
    await navigate({ to: Route.fullPath, replace: true, search, hash: location.hash });
  }, [checkoutSessionId, navigate, router]);

  return (
    <AdminRouteShell>
      <AdminBillingPage
        data={data}
        search={search}
        hash={hash}
        checkoutSessionId={checkoutSessionId}
        committed={committed}
        onReload={reload}
        onCheckoutSynced={finishCheckout}
      />
    </AdminRouteShell>
  );
}
