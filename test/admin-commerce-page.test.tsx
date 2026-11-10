/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";
import {
  createBrowserHistory,
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { act } from "react";
import { JSDOM } from "jsdom";
import { changeValue } from "./support/admin-dom-events";

import {
  AdminCommercePage,
  isCommerceTabOnlyNavigation,
} from "../src/admin/components/admin-commerce-page";
import AdminCommerceSafetySettings from "../src/admin/components/admin-commerce-safety-settings";
import AdminCommerceSalesPanelSettings from "../src/admin/components/admin-commerce-sales-panel-settings";
import AdminCommerceSupportSettings, {
  type CommerceSupportForm,
} from "../src/admin/components/admin-commerce-support-settings";
import { ToastProvider } from "../src/admin/components/toast";
import type { CommerceLoaderData } from "../src/admin/lib/admin-route-loaders";
import type { CommerceTab } from "../src/admin/lib/admin-route-state";
import type { AdminRouterContext } from "../src/admin/routes/context";
import { AdminRouteContextProvider } from "../src/admin/routes/page-context";

const data: CommerceLoaderData = {
  guildId: "guild-1",
  sellerProfile: {
    lifecycleState: "active",
    approvalState: "approved",
    supportContact: "seller@example.test",
  } as CommerceLoaderData["sellerProfile"],
  dashboard: {
    seller: {
      connectedAccountId: "account-1",
      status: "active",
      chargesEnabled: true,
      payoutsEnabled: true,
      detailsSubmitted: true,
    },
    offerings: [
      {
        offering: {
          id: "offering-1",
          connectedAccountId: "account-1",
          guildId: "guild-1",
          discordRoleId: "role-1",
          name: "Gold supporters",
          description: "Private community access",
          purchaseType: "subscription",
          status: "active",
          archivedAtMs: null,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
        lifecycle: "published",
        subscribers: {
          active: 3,
          canceling: 1,
          pastDue: 0,
          grace: 0,
          disputed: 0,
        },
        grossByCurrency: { AUD: 1_500, USD: 900 },
        refundsByCurrency: { AUD: 0, USD: 0 },
        disputesByCurrency: { AUD: 0, USD: 0 },
        estimatedProceedsByCurrency: { AUD: 1_425, USD: 855 },
        activePrices: [
          {
            id: "price-1",
            connectedAccountId: "account-1",
            offeringId: "offering-1",
            stripeProductId: "prod_1",
            stripePriceId: "price_1",
            currency: "AUD",
            unitAmountMinor: 500,
            priceType: "recurring",
            recurringInterval: "month",
            status: "active",
            providerCreatedAtMs: 1,
            retiredAtMs: null,
            createdAtMs: 1,
          },
        ],
        includedBenefits: ["Private role"],
        supportContact: "seller@example.test",
        upcomingCancellations: 1,
        roleFailures: 0,
        reconciliationIncidents: 0,
        retirement: null,
      },
    ],
    estimatedProceedsAreNonAuthoritative: true,
  },
  support: null,
  supportReport: [],
  salesPanel: {
    connectedAccountId: "account-1",
    guildId: "guild-1",
    channelId: "channel-1",
    title: "Join Rogers's community",
    description: "Choose the membership that suits you.",
    messageId: "message-1",
    lastErrorCode: null,
    createdAtMs: 1,
    updatedAtMs: 1,
  },
  panelChannels: [{ id: "channel-1", name: "support" }],
  manageableRoles: [{ id: "role-1", name: "Gold" }],
  currentTermsVersion: "seller-terms-2026-07",
  activeOfferingLimit: 5,
  stripeDashboardAvailable: true,
  sellerOnboardingAvailable: true,
  sellerOwner: true,
};

const safeguards = {
  connectedAccountId: "account-1",
  guildId: "guild-1",
  controls: [],
  usage: {
    activeSubscribers: 3,
    activeOfferings: 1,
    monthlyGrossMinor: { AUD: 1_500, USD: 900 },
    checkoutCounts: { open: 0, succeeded: 0, failed: 0 },
    webhookCounts: { accepted: 0, duplicate: 0, quarantined: 0 },
    reconciliation: { staleCount: 0, failedCount: 0 },
    roles: { pending: 0, failed: 0, deadLetter: 0 },
    subscriptions: { active: 3, pastDue: 0, grace: 0, disputed: 0 },
    refunds: { count: 0, amountMinor: { AUD: 0, USD: 0 } },
    disputes: { open: 0, amountMinor: { AUD: 0, USD: 0 } },
    feesMinor: { AUD: 75, USD: 45 },
    restrictedSeller: false,
    oldestRepairAgeMs: null,
  },
  limits: {
    activeSubscribers: 100,
    activeOfferings: 5,
    monthlyGrossMinor: 500_000,
    supportPaymentMinor: 50_000,
    alertThresholds: [70, 90, 100] as const,
  },
  blockReasons: [],
} satisfies NonNullable<CommerceLoaderData["safeguards"]>;

const supportForm: CommerceSupportForm = {
  enabled: true,
  explanation: "Helps fund ordinary community hosting and moderation costs.",
  currency: "AUD",
  suggestedAmounts: "5.00, 10.00",
  supportContact: "seller@example.test",
};

test("Commerce tab navigation preserves drafts but does not bypass another server or workspace", () => {
  const current = {
    pathname: "/admin/guild-1/commerce",
    search: { workspaceId: "one", tab: "storefront" },
  };
  assert.equal(
    isCommerceTabOnlyNavigation({
      current,
      next: { ...current, search: { tab: "support", workspaceId: "one" } },
    }),
    true,
  );
  assert.equal(
    isCommerceTabOnlyNavigation({
      current,
      next: { ...current, search: { workspaceId: "two", tab: "storefront" } },
    }),
    false,
  );
  assert.equal(
    isCommerceTabOnlyNavigation({
      current,
      next: { ...current, pathname: "/admin/guild-2/commerce" },
    }),
    false,
  );
  assert.equal(
    isCommerceTabOnlyNavigation({
      current,
      next: { ...current, search: { ...current.search, guildId: "guild-2" } },
    }),
    false,
  );
});

test("Storefront edits survive tab switches and warn before unloading until saved", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "https://example.com/?tab=storefront",
  });
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    HTMLElement: globalThis.HTMLElement,
    self: globalThis.self,
    fetch: globalThis.fetch,
  };
  const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previousAct = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    self: dom.window,
  });
  Object.assign(dom.window.HTMLElement.prototype, { attachEvent() {}, detachEvent() {} });
  const container = document.getElementById("root")!;
  // React DOM must detect the browser environment before its first import.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  const context = {
    currentPath: "/admin/commerce",
    selectedWorkspaceId: "workspace-1",
    selectedGuildId: "guild-1",
    pathGuildId: "guild-1",
    guildDirectory: [],
  } as unknown as AdminRouterContext;
  const rootRoute = createRootRoute({
    component: () => (
      <ToastProvider>
        <AdminCommercePage
          selectedWorkspaceId="workspace-1"
          selectedGuildId="guild-1"
          initialData={data}
        />
      </ToastProvider>
    ),
  });
  const router = createRouter({
    routeTree: rootRoute,
    history: createBrowserHistory({ window: dom.window }),
  });
  // Node resolves TanStack's server entry, which reads snapshots without subscribing.
  // Re-render the app context after navigation, as the browser App does for route changes.
  const renderPage = () =>
    root.render(
      <AdminRouteContextProvider
        value={{ ...context, currentSearch: router.state.location.searchStr }}
      >
        <RouterProvider router={router} />
      </AdminRouteContextProvider>,
    );
  const unloadIsBlocked = () =>
    !dom.window.dispatchEvent(new dom.window.Event("beforeunload", { cancelable: true }));
  const input = (id: string) => {
    const element = container.querySelector<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
    assert.ok(element, id);
    return element;
  };
  const change = async (id: string, value: string) => {
    await act(async () => {
      const element = input(id);
      changeValue(element, value);
    });
  };
  try {
    await router.load();
    await act(async () => {
      renderPage();
    });
    assert.equal(unloadIsBlocked(), false);
    await change("commerce-branding-accent", "#123456");
    await change("commerce-branding-tagline", "Welcome, squad!");
    await change("commerce-sales-panel-title", "Join our squad");
    await change("commerce-sales-panel-description", "Pick a membership");
    assert.equal(unloadIsBlocked(), true);
    await act(async () => {
      await router.navigate({ to: "/?tab=support" });
      await router.load();
      renderPage();
    });
    assert.equal(router.state.location.searchStr, "?tab=support");
    assert.ok(container.querySelector("#commerce-branding-tagline") === null);
    await act(async () => {
      await router.navigate({ to: "/?tab=storefront" });
      await router.load();
      renderPage();
    });
    assert.equal(input("commerce-branding-accent").value, "#123456");
    assert.equal(input("commerce-branding-tagline").value, "Welcome, squad!");
    assert.equal(input("commerce-sales-panel-title").value, "Join our squad");
    assert.equal(input("commerce-sales-panel-description").value, "Pick a membership");

    let savedData = data;
    globalThis.fetch = async (_url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        savedData = {
          ...data,
          branding: {
            ...data.branding,
            accentColor: body.accentColor,
            tagline: body.tagline,
          } as NonNullable<CommerceLoaderData["branding"]>,
        };
        return Response.json({ ok: true });
      }
      return Response.json(savedData);
    };
    const save = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Save branding",
    );
    assert.ok(save);
    await act(async () => {
      save.click();
    });
    assert.equal(
      unloadIsBlocked(),
      true,
      "Unpublished panel edits remain protected after saving branding",
    );
    await change("commerce-sales-panel-title", data.salesPanel?.title ?? "");
    await change("commerce-sales-panel-description", data.salesPanel?.description ?? "");
    assert.equal(unloadIsBlocked(), false, "Saved branding and reverted panel are pristine");
  } finally {
    await act(async () => {
      root.unmount();
    });
    Object.assign(globalThis, previous);
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousAct;
    dom.window.close();
  }
});

function renderCommercePage({
  tab = "offerings",
  initialData = data,
}: {
  tab?: CommerceTab;
  initialData?: CommerceLoaderData;
} = {}) {
  const rootRoute = createRootRoute({
    component: () => (
      <ToastProvider>
        <AdminCommercePage
          selectedWorkspaceId="workspace-1"
          selectedGuildId="guild-1"
          initialData={initialData}
        />
      </ToastProvider>
    ),
  });
  const context = {
    currentPath: "/admin/guild-1/commerce",
    currentSearch: `?tab=${tab}`,
    selectedWorkspaceId: "workspace-1",
    selectedGuildId: "guild-1",
    pathGuildId: "guild-1",
    commerceTab: tab,
  } as AdminRouterContext;
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [`/?tab=${tab}`] }),
    context,
  });
  router.stores.setMatches(
    router
      .matchRoutes(router.state.location)
      .map((match) => ({ ...match, status: "success" as const })),
  );

  return renderToString(
    <AdminRouteContextProvider value={context}>
      <RouterProvider router={router} context={context} />
    </AdminRouteContextProvider>,
  );
}

test("Commerce Admin renders responsive seller, offering, and currency-safe financial states", () => {
  const html = renderCommercePage();

  assert.match(html, /Commerce status/);
  assert.match(html, /Accepting sales/);
  assert.match(html, /All clear/);
  assert.match(html, /Gold supporters/);
  assert.match(html, /3 active · 1 canceling/);
  assert.match(html, /data-responsive-table-view="table"/);
  assert.match(html, /Make unavailable/);
  assert.match(html, />New offering</);
  assert.doesNotMatch(html, /One-time community support/);
  assert.doesNotMatch(html, /Pilot safeguards/);
});

test("Commerce Admin flags a non-purchasable seller before reporting active sales", () => {
  for (const sellerProfile of [
    { ...data.sellerProfile!, lifecycleState: "suspended" as const },
    { ...data.sellerProfile!, approvalState: "pending" as const },
  ]) {
    const html = renderCommercePage({ initialData: { ...data, sellerProfile } });

    assert.match(html, /Action required/);
    assert.match(html, /Account action required/);
    assert.doesNotMatch(html, /Accepting sales/);
    assert.doesNotMatch(html, /All clear/);
  }
});

test("Commerce Admin confirms when a submitted seller is under review", () => {
  const html = renderCommercePage({
    tab: "seller",
    initialData: {
      ...data,
      sellerProfile: {
        ...data.sellerProfile!,
        lifecycleState: "pending_review",
        approvalState: "pending",
      },
    },
  });
  assert.match(html, /seller application has been submitted and is being reviewed/i);
  assert.match(html, /Sales\s+stay disabled until it is approved/i);
});

test("Commerce Admin renders the published sales panel controls", () => {
  const html = renderToString(
    <AdminCommerceSalesPanelSettings
      salesPanel={data.salesPanel}
      panelChannels={data.panelChannels ?? []}
      panelChannelId="channel-1"
      panelTitle={data.salesPanel?.title ?? ""}
      panelDescription={data.salesPanel?.description ?? ""}
      onTitleChange={() => {}}
      onDescriptionChange={() => {}}
      busyAction={null}
      onChannelChange={() => {}}
      onPublish={() => {}}
      onUnpublish={() => {}}
    />,
  );
  assert.match(html, /Commerce sales panel/);
  assert.match(html, /Join Rogers&#x27;s community/);
  assert.match(html, /Choose the membership that suits you\./);
  assert.match(html, /Refresh sales panel/);

  const moving = renderToString(
    <AdminCommerceSalesPanelSettings
      salesPanel={data.salesPanel}
      panelChannels={[...(data.panelChannels ?? []), { id: "channel-2", name: "store" }]}
      panelChannelId="channel-2"
      panelTitle={data.salesPanel?.title ?? ""}
      panelDescription={data.salesPanel?.description ?? ""}
      onTitleChange={() => {}}
      onDescriptionChange={() => {}}
      busyAction={null}
      onChannelChange={() => {}}
      onPublish={() => {}}
      onUnpublish={() => {}}
    />,
  );
  assert.match(moving, /Move sales panel/);
});

test("Commerce Admin exposes seller onboarding to an eligible Guild owner", () => {
  const html = renderCommercePage({
    tab: "seller",
    initialData: {
      ...data,
      sellerProfile: null,
      dashboard: null,
      stripeDashboardAvailable: false,
      sellerOnboardingAvailable: true,
      sellerOwner: true,
      sellerSuggestedSupportContact: "owner@example.test",
    },
  });

  assert.match(html, /Connect a Stripe seller account/);
  assert.match(html, /Continue to Stripe/);
  assert.match(html, /seller-terms-2026-07/);
  assert.match(html, /5% fee/);
  assert.match(html, /value="owner@example\.test"/);
});

test("Commerce Admin renders support and safety controls in independently loaded panels", () => {
  const support = renderToString(
    <AdminCommerceSupportSettings
      support={supportForm}
      supportReport={[]}
      busyAction={null}
      onChange={() => {}}
      onSave={() => {}}
    />,
  );
  assert.match(support, /One-time community support/);
  assert.match(support, /Save support settings/);

  const safety = renderToString(
    <AdminCommerceSafetySettings
      safeguards={safeguards}
      busyAction={null}
      onSetSafeguard={() => {}}
    />,
  );
  assert.match(safety, /Pilot safeguards/);
  assert.match(safety, /new checkouts/);
  assert.match(safety, /Stop renewals/);
});

test("Commerce Admin shows retirement failures and hides archive while subscriptions remain", () => {
  const html = renderCommercePage({
    initialData: {
      ...data,
      dashboard: {
        ...data.dashboard!,
        offerings: [
          {
            ...data.dashboard!.offerings[0]!,
            lifecycle: "retiring",
            retirement: {
              status: "waiting_for_period_end",
              activeSubscriptionCount: 1,
              scheduledCancellationCount: 0,
              failedCancellationCount: 1,
              latestPeriodEndMs: 1_900_000_000_000,
              completedAtMs: null,
            },
          },
        ],
      },
    },
  });

  assert.match(html, /waiting for period end/);
  assert.match(html, /1(?:<!-- -->)? active/);
  assert.match(html, /1 failed/);
  assert.doesNotMatch(html, />Archive</);
});

test("Commerce Admin isolates seller, support, and safety workflows in their tabs", () => {
  const seller = renderCommercePage({ tab: "seller" });
  assert.match(seller, /Seller account/);
  assert.match(seller, /Financial activity/);
  assert.match(seller, /Seller offboarding/);
  assert.doesNotMatch(seller, /Offerings and subscribers/);

  const support = renderCommercePage({ tab: "support" });
  assert.match(support, /Loading support payments|One-time community support/);
  assert.doesNotMatch(support, /Offerings and subscribers/);

  const safety = renderCommercePage({ tab: "safety" });
  assert.match(safety, /Loading safety controls|Pilot safeguards/);
  assert.doesNotMatch(safety, /One-time community support/);
});
