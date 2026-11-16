import { adminErrorResponse } from "./support/admin-error-response";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { act, useState, type ReactNode } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { changeValue } from "./support/admin-dom-events";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";

import { defaultClanManagementConfig, type ClanRequest } from "../src/clans";
import type { ClansLoaderData, ServerLevelsLoaderData } from "../src/admin/lib/admin-route-loaders";
import type { FeedbackSnapshot } from "../src/admin/components/admin-feedback-dialog";
import type { AdminRouterContext } from "../src/admin/routes/context";
import { DEFAULT_USER_PREFERENCES } from "../src/runtime/admin-types";
import { deferred } from "./support/deferred";

// Load admin components inside withDom so Radix's portals and layout effects use the DOM.
async function withDom(run: (env: { container: HTMLElement; root: Root }) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://example.com/" });
  const globals: Record<string, unknown> = {
    window: dom.window,
    document: dom.window.document,
    self: dom.window,
    Node: dom.window.Node,
    DocumentFragment: dom.window.DocumentFragment,
    NodeFilter: dom.window.NodeFilter,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    HTMLSelectElement: dom.window.HTMLSelectElement,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    KeyboardEvent: dom.window.KeyboardEvent,
    getComputedStyle: dom.window.getComputedStyle,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => undefined,
    ResizeObserver: class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: globalThis.fetch,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  Object.assign(dom.window.HTMLElement.prototype, {
    attachEvent() {},
    detachEvent() {},
    scrollIntoView() {},
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  const container = document.querySelector<HTMLElement>("#root");
  assert.ok(container);
  // React DOM must detect the browser environment before its first import.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  const { resetGuildResourcesCache } = await import("../src/admin/lib/guild-resources-cache");
  resetGuildResourcesCache();
  try {
    await run({ container, root });
  } finally {
    await act(async () => {
      root.unmount();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    resetGuildResourcesCache();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

function button(
  label: string,
  within: Pick<ParentNode, "querySelectorAll"> = document.body,
): HTMLButtonElement {
  const found = [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) => element.textContent?.trim() === label,
  );
  assert.ok(found, `Button ${label} exists`);
  return found;
}

async function click(label: string, within: Pick<ParentNode, "querySelectorAll"> = document.body) {
  const target = button(label, within);
  assert.equal(target.disabled, false, `${label} is enabled`);
  await act(async () => target.click());
}

async function change(element: Element | HTMLSelectElement, value: string) {
  await act(async () => changeValue(element, value));
}

async function mountInRouter(root: Root, page: ReactNode) {
  const rootRoute = createRootRoute();
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/",
    component: () => page,
  });
  const nextRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: "/next",
    component: () => <p>Next page</p>,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, nextRoute]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await router.load();
  await act(async () => root.render(<RouterProvider router={router} />));
  return router;
}

function resourcesResponse() {
  return Response.json({
    guildId: "guild-1",
    roles: [],
    categories: [],
    textChannels: [
      { id: "channel-saved", name: "saved" },
      { id: "channel-draft", name: "draft" },
    ],
    voiceChannels: [],
    forumChannels: [],
  });
}

function clanData(): ClansLoaderData {
  const request: ClanRequest = {
    id: "request-1",
    guildId: "guild-1",
    requesterId: "123456789",
    name: "Raiders",
    normalizedName: "raiders",
    tag: "RAID",
    normalizedTag: "raid",
    description: "Weekend raids",
    focus: "Progression",
    recruitmentState: "applications-open",
    proposedOfficerIds: [],
    status: "pending",
    revision: 1,
    reviewerId: null,
    reviewReason: null,
    clanId: null,
    createdAtMs: 1,
    updatedAtMs: 1,
    terminalAtMs: null,
    retentionExpiresAtMs: null,
  };
  return {
    guildId: "guild-1",
    config: defaultClanManagementConfig("guild-1", 1),
    requests: [request],
    clans: [],
    setup: { readiness: "ready_disabled", run: null },
    recommendedSetupChoices: null,
  };
}

for (const stale of [false, true]) {
  test(`Clan settings survive ${stale ? "stale" : "successful"} review refresh and guard navigation until discarded`, async () => {
    await withDom(async ({ container, root }) => {
      const { AdminClansPage } = await import("../src/admin/components/admin-clans-page");
      const initialData = clanData();
      const latest = {
        ...initialData,
        config: {
          ...initialData.config,
          requestPanelTitle: "Saved elsewhere",
          requestPanelButtonLabel: "Refreshed label",
          updatedAtMs: 2,
        },
        requests: initialData.requests.map((request) => ({ ...request, revision: 2 })),
      };
      globalThis.fetch = async (input) => {
        const path = String(input).split("?")[0];
        if (path === "/admin/api/tickets/resources") return resourcesResponse();
        if (path === "/admin/api/clans/requests/review") {
          return stale
            ? adminErrorResponse("Request revision changed.", 409)
            : Response.json({ ok: true });
        }
        if (path === "/admin/api/clans") return Response.json(latest);
        throw new Error(`Unexpected request: ${input}`);
      };
      let routeRefreshes = 0;
      function Page() {
        const [generation, setGeneration] = useState(0);
        return (
          <AdminClansPage
            key={generation}
            selectedWorkspaceId="workspace-1"
            selectedGuildId="guild-1"
            initialData={generation ? latest : initialData}
            onRouteDataRefresh={async () => {
              routeRefreshes += 1;
              setGeneration((value) => value + 1);
            }}
          />
        );
      }
      const router = await mountInRouter(root, <Page />);
      const title = container.querySelector<HTMLInputElement>('input[value="Create a Clan"]');
      assert.ok(title);
      await change(title, "My unfinished title");
      await click("Review request", container);
      await click("Approve request");
      assert.equal(title.value, "My unfinished title");
      assert.ok(
        container.querySelector('input[value="Refreshed label"]'),
        "unedited fields refresh",
      );
      assert.match(container.textContent ?? "", /Unsaved changes/);
      assert.equal(routeRefreshes, 0, "a route remount must not erase the settings draft");
      if (stale) {
        assert.match(
          document.querySelector('[role="alert"]')?.textContent ?? "",
          /latest revision/,
        );
        assert.match(
          document.querySelector('[role="alertdialog"]')?.textContent ?? "",
          /Revision 2/,
        );
        await click("Cancel");
      }
      await act(async () => {
        void router.navigate({ to: "/next" });
      });
      assert.match(
        document.querySelector('[role="alertdialog"]')?.textContent ?? "",
        /Leave page\?/,
      );
      await click("Stay");
      assert.equal(router.history.location.pathname, "/");
      assert.equal(title.value, "My unfinished title");
      await click("Discard changes", container);
      await click("Discard changes", document.querySelector('[role="alertdialog"]')!);
      assert.equal(title.value, "Saved elsewhere", "discard restores the refreshed baseline");
      assert.doesNotMatch(container.textContent ?? "", /Unsaved changes/);
      await change(title, "Another unfinished title");
      await act(async () => {
        void router.navigate({ to: "/next" });
      });
      await click("Leave");
      // TanStack's Node entry does not mount the browser history subscriber.
      assert.equal(router.history.location.pathname, "/next");
    });
  });
}

for (const newerTitle of ["Newer edit", "Create a Clan"]) {
  test(`Clan save retains in-flight edit to ${newerTitle} and discards to the actual saved response`, async () => {
    await withDom(async ({ container, root }) => {
      const { AdminClansPage } = await import("../src/admin/components/admin-clans-page");
      const initialData = clanData();
      const response = deferred<Response>();
      let routeRefreshes = 0;
      let submitted: Record<string, unknown> | undefined;
      globalThis.fetch = async (input, init) => {
        if (String(input).startsWith("/admin/api/tickets/resources")) return resourcesResponse();
        assert.equal(input, "/admin/api/clans/config");
        submitted = JSON.parse(String(init?.body));
        return response.promise;
      };
      await act(async () =>
        root.render(
          <AdminClansPage
            selectedWorkspaceId="workspace-1"
            selectedGuildId="guild-1"
            initialData={initialData}
            onRouteDataRefresh={async () => {
              routeRefreshes += 1;
            }}
          />,
        ),
      );
      const title = container.querySelector<HTMLInputElement>('input[value="Create a Clan"]');
      assert.ok(title);
      await change(title, "Submitted title");
      await click("Save Clan settings");
      assert.equal(submitted?.requestPanelTitle, "Submitted title");
      await change(title, newerTitle);
      await act(async () =>
        response.resolve(
          Response.json({
            config: {
              ...initialData.config,
              requestPanelTitle: "Submitted title",
              requestPanelButtonLabel: "Normalized label",
              updatedAtMs: 2,
            },
          }),
        ),
      );
      assert.equal(title.value, newerTitle);
      assert.equal(routeRefreshes, 0, "a route remount must not erase newer edits");
      assert.match(container.textContent ?? "", /Unsaved changes/);
      await click("Discard changes", container);
      await click("Discard changes", document.querySelector('[role="alertdialog"]')!);
      assert.equal(title.value, "Submitted title");
      assert.ok(container.querySelector('input[value="Normalized label"]'));
      assert.doesNotMatch(container.textContent ?? "", /Unsaved changes/);
      assert.equal(button("Save Clan settings").disabled, true);
    });
  });
}

for (const staleReview of [false, true]) {
  test(`Clan ${staleReview ? "conflicted" : "successful"} review cannot replace a newer saved baseline with a delayed snapshot`, async () => {
    await withDom(async ({ container, root }) => {
      const { AdminClansPage } = await import("../src/admin/components/admin-clans-page");
      const initialData = clanData();
      const saveResponse = deferred<Response>();
      const reviewResponse = deferred<Response>();
      const writes: Array<Record<string, unknown>> = [];
      let reviewReadStarted = false;
      let routeRefreshes = 0;
      globalThis.fetch = async (input, init) => {
        const path = String(input).split("?")[0];
        if (path === "/admin/api/tickets/resources") return resourcesResponse();
        if (path === "/admin/api/clans/config") {
          const write = JSON.parse(String(init?.body));
          writes.push(write);
          return writes.length === 1
            ? saveResponse.promise
            : Response.json({ config: { ...write, updatedAtMs: 3 } });
        }
        if (path === "/admin/api/clans/requests/review") {
          return staleReview
            ? adminErrorResponse("Request revision changed.", 409)
            : Response.json({ ok: true });
        }
        assert.equal(path, "/admin/api/clans");
        reviewReadStarted = true;
        return reviewResponse.promise;
      };
      await act(async () =>
        root.render(
          <AdminClansPage
            selectedWorkspaceId="workspace-1"
            selectedGuildId="guild-1"
            initialData={initialData}
            onRouteDataRefresh={async () => {
              routeRefreshes += 1;
            }}
          />,
        ),
      );
      const title = container.querySelector<HTMLInputElement>('input[value="Create a Clan"]');
      const label = container.querySelector<HTMLInputElement>('input[value="Create Clan"]');
      assert.ok(title && label);
      await change(title, "Successfully saved title");
      await click("Save Clan settings");
      await change(label, "Unfinished button label");
      await click("Review request", container);
      await click("Approve request");
      assert.equal(reviewReadStarted, true);
      await act(async () =>
        saveResponse.resolve(
          Response.json({
            config: {
              ...initialData.config,
              requestPanelTitle: "Successfully saved title",
              updatedAtMs: 2,
            },
          }),
        ),
      );
      await act(async () =>
        reviewResponse.resolve(
          Response.json({
            ...initialData,
            requests: initialData.requests.map((request) => ({ ...request, revision: 2 })),
          }),
        ),
      );
      assert.equal(title.value, "Successfully saved title");
      assert.equal(label.value, "Unfinished button label");
      assert.equal(routeRefreshes, 0);
      if (staleReview) await click("Cancel");
      await click("Save Clan settings");
      assert.equal(writes[1]?.requestPanelTitle, "Successfully saved title");
      assert.equal(writes[1]?.requestPanelButtonLabel, "Unfinished button label");
      assert.doesNotMatch(container.textContent ?? "", /Unsaved changes/);
      await change(title, "Another draft");
      await click("Discard changes", container);
      await click("Discard changes", document.querySelector('[role="alertdialog"]')!);
      assert.equal(title.value, "Successfully saved title");
      assert.equal(label.value, "Unfinished button label");
    });
  });
}

test("clean Clan review refresh locks settings until a route refresh finishes", async () => {
  await withDom(async ({ container, root }) => {
    const { AdminClansPage } = await import("../src/admin/components/admin-clans-page");
    const initialData = clanData();
    const refresh = deferred<void>();
    let routeRefreshes = 0;
    globalThis.fetch = async (input) => {
      const path = String(input).split("?")[0];
      if (path === "/admin/api/tickets/resources") return resourcesResponse();
      if (path === "/admin/api/clans/requests/review") return Response.json({ ok: true });
      assert.equal(path, "/admin/api/clans");
      return Response.json({ ...initialData, config: { ...initialData.config, updatedAtMs: 2 } });
    };
    await act(async () =>
      root.render(
        <AdminClansPage
          selectedWorkspaceId="workspace-1"
          selectedGuildId="guild-1"
          initialData={initialData}
          onRouteDataRefresh={async () => {
            routeRefreshes += 1;
            await refresh.promise;
          }}
        />,
      ),
    );
    const title = container.querySelector<HTMLInputElement>('input[value="Create a Clan"]');
    assert.ok(title);
    await click("Review request", container);
    await click("Approve request");
    assert.equal(routeRefreshes, 1);
    assert.equal(title.matches(":disabled"), true);
    await act(async () => refresh.resolve());
    assert.equal(title.matches(":disabled"), false);
    assert.doesNotMatch(container.textContent ?? "", /Unsaved changes/);
  });
});

test("Server Levels toggles only saved settings, saves channel with saved enabled state, and protects failed drafts", async () => {
  await withDom(async ({ container, root }) => {
    const { AdminServerLevelsPage } =
      await import("../src/admin/components/admin-server-levels-page");
    const { ToastProvider } = await import("../src/admin/components/toast");
    const initialData: ServerLevelsLoaderData = {
      config: {
        guildId: "guild-1",
        enabled: true,
        announcementChannelId: "channel-saved",
        removedAtMs: null,
        updatedAtMs: 1,
      },
      servers: [],
      beta: true,
      maxServers: 5,
      requiredEvents: [],
      steamLinkConfigured: true,
      credentialEncryptionAvailable: true,
      processingAvailable: true,
    };
    const writes: Array<Record<string, unknown>> = [];
    let failNext = false;
    globalThis.fetch = async (input, init) => {
      const path = String(input).split("?")[0];
      if (path === "/admin/api/tickets/resources") return resourcesResponse();
      if (path === "/admin/api/permissions/diagnostics")
        return Response.json({ checksByFeature: {} });
      assert.equal(path, "/admin/api/server-levels/config");
      writes.push(JSON.parse(String(init?.body)));
      if (failNext) {
        failNext = false;
        return adminErrorResponse("Could not save channel.", 503);
      }
      return Response.json({ ok: true });
    };
    const router = await mountInRouter(
      root,
      <ToastProvider>
        <AdminServerLevelsPage
          selectedWorkspaceId="workspace-1"
          selectedGuildId="guild-1"
          initialData={initialData}
        />
      </ToastProvider>,
    );
    const channel = container.querySelector<HTMLButtonElement>("#server-level-announcements");
    assert.ok(channel);
    await act(async () =>
      channel.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    const draftOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (option) => option.textContent === "#draft",
    );
    assert.ok(draftOption);
    await act(async () =>
      draftOption.dispatchEvent(
        new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      ),
    );
    const toggle = container.querySelector<HTMLButtonElement>(
      '[aria-label="Enable Server Levels"]',
    );
    assert.ok(toggle);
    await act(async () => toggle.click());
    assert.deepEqual(writes[0], {
      enabled: false,
      announcementChannelId: "channel-saved",
      guildId: "guild-1",
      workspaceId: "workspace-1",
    });
    assert.match(
      container.querySelector("#server-level-announcements")?.textContent ?? "",
      /draft/,
    );
    assert.match(container.textContent ?? "", /Unsaved changes/);
    await click("Save channel");
    assert.deepEqual(writes[1], {
      enabled: false,
      announcementChannelId: "channel-draft",
      guildId: "guild-1",
      workspaceId: "workspace-1",
    });
    assert.match(
      document.querySelector('[data-toast-container] [role="status"]')?.textContent ?? "",
      /announcement channel saved/,
    );
    assert.doesNotMatch(container.textContent ?? "", /Unsaved changes/);
    assert.equal(toggle.getAttribute("aria-checked"), "false");

    await click("Clear");
    failNext = true;
    await click("Save channel");
    assert.match(container.textContent ?? "", /Unsaved changes/);
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /Could not save channel/,
    );
    await act(async () => {
      void router.navigate({ to: "/next" });
    });
    await click("Stay");
    await click("Discard changes", container);
    await click("Discard changes", document.querySelector('[role="alertdialog"]')!);
    assert.match(
      container.querySelector("#server-level-announcements")?.textContent ?? "",
      /draft/,
    );
    assert.doesNotMatch(container.textContent ?? "", /Unsaved changes/);
    await click("Clear");
    await click("Save channel");
    assert.equal(writes.at(-1)?.announcementChannelId, null);
    assert.equal(writes.at(-1)?.enabled, false);
    assert.match(
      document.querySelector('[data-toast-container] [role="status"]')?.textContent ?? "",
      /announcement channel cleared/,
    );
    assert.doesNotMatch(container.textContent ?? "", /Unsaved changes/);
  });
});

test("feedback dismissal and failed send preserve draft and original context; success and discard start fresh", async () => {
  await withDom(async ({ root }) => {
    const { AdminFeedbackProvider, useAdminFeedback } =
      await import("../src/admin/components/admin-feedback-dialog");
    function Trigger() {
      const open = useAdminFeedback();
      return <button onClick={() => open?.()}>Open feedback</button>;
    }
    let context: FeedbackSnapshot = {
      route: "/admin/clans",
      pageLabel: "Clans",
      guildId: "123",
      correlationId: "original-correlation",
    };
    const render = () =>
      root.render(
        <AdminFeedbackProvider context={context}>
          <Trigger />
        </AdminFeedbackProvider>,
      );
    const submissions: Array<Record<string, unknown>> = [];
    let failNext = true;
    globalThis.fetch = async (input, init) => {
      assert.equal(input, "/admin/api/feedback");
      submissions.push(JSON.parse(String(init?.body)));
      if (failNext) {
        failNext = false;
        return adminErrorResponse("Try later.", 503, {
          code: "service_unavailable",
          correlationId: "failed-send",
          retryable: true,
        });
      }
      return Response.json({ ok: true, reference: "FB-123", receivedAtMs: 1 }, { status: 201 });
    };
    await act(async () => render());
    await click("Open feedback");
    const summary = document.querySelector<HTMLInputElement>(
      '[role="alertdialog"] input:not([type="checkbox"])',
    );
    const description = document.querySelector<HTMLTextAreaElement>("textarea");
    const category = document.querySelector("select");
    const diagnostics = document.querySelector<HTMLInputElement>('input[type="checkbox"]');
    assert.ok(summary && description && category && diagnostics);
    await change(summary, "My unfinished summary");
    await change(description, "Private feedback text");
    await change(category, "problem");
    await act(async () => diagnostics.click());
    await click("Cancel");
    context = {
      route: "/admin/server-levels",
      pageLabel: "Server Levels",
      guildId: "456",
      correlationId: "new-correlation",
    };
    await act(async () => render());
    await click("Open feedback");
    assert.equal(
      document.querySelector<HTMLInputElement>('[role="alertdialog"] input:not([type="checkbox"])')
        ?.value,
      "My unfinished summary",
    );
    assert.equal(document.querySelector("textarea")?.value, "Private feedback text");
    assert.equal(document.querySelector("select")?.value, "problem");
    assert.equal(document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked, true);
    const preview = () =>
      document.querySelector('[aria-label="Feedback context preview"]')?.textContent ?? "";
    assert.match(preview(), /\/admin\/clans/);
    assert.match(preview(), /original-correlation/);
    assert.doesNotMatch(preview(), /server-levels|new-correlation|456/);
    await click("Send feedback");
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /Try later/);
    await click("Cancel");
    await click("Open feedback");
    assert.match(document.querySelector('[role="alert"]')?.textContent ?? "", /Try later/);
    assert.equal(document.querySelector("textarea")?.value, "Private feedback text");
    await click("Send feedback");
    assert.equal(submissions.length, 2);
    assert.deepEqual(submissions[0], submissions[1]);
    assert.equal(submissions[1]?.route, "/admin/clans");
    assert.equal(submissions[1]?.guildId, "123");
    assert.match(document.querySelector('[role="alertdialog"]')?.textContent ?? "", /FB-123/);
    await click("Close");
    await click("Open feedback");
    assert.equal(
      document.querySelector<HTMLInputElement>('[role="alertdialog"] input:not([type="checkbox"])')
        ?.value,
      "",
    );
    assert.equal(document.querySelector("textarea")?.value, "");
    assert.equal(
      document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
      false,
    );
    assert.match(preview(), /server-levels/);
    await change(document.querySelector("textarea")!, "Discard this text");
    await click("Discard draft");
    context = { route: "/admin/tickets", guildId: "789" };
    await act(async () => render());
    await click("Open feedback");
    assert.equal(document.querySelector("textarea")?.value, "");
    assert.match(preview(), /\/admin\/tickets/);
    assert.doesNotMatch(preview(), /server-levels|456/);
  });
});

test(
  "feedback survives mounted shell navigation and scope changes, and clears with the authenticated tree",
  { timeout: 15000 },
  async () => {
    await withDom(async ({ container, root }) => {
      const { AdminRouteContextProvider, AdminRouteShell } =
        await import("../src/admin/routes/page-context");
      const { NavigationGuard } = await import("../src/admin/components/navigation-guard");
      const { getAdminRouteState } = await import("../src/admin/lib/admin-route-state");
      function Commerce() {
        const [dirty, setDirty] = useState(false);
        return (
          <AdminRouteShell>
            <NavigationGuard hasChanges={dirty} onDiscardChanges={() => setDirty(false)} />
            <button onClick={() => setDirty(true)}>Edit storefront draft</button>
          </AdminRouteShell>
        );
      }
      function Profile() {
        return (
          <AdminRouteShell>
            <p>Profile page</p>
          </AdminRouteShell>
        );
      }
      const rootRoute = createRootRoute();
      const commerceRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/admin/$guildId/commerce",
        remountDeps: ({ params }) => params.guildId,
        component: Commerce,
      });
      const profileRoute = createRoute({
        getParentRoute: () => rootRoute,
        path: "/admin/profile",
        component: Profile,
      });
      const router = createRouter({
        routeTree: rootRoute.addChildren([commerceRoute, profileRoute]),
        history: createMemoryHistory({
          initialEntries: ["/admin/123/commerce?workspaceId=workspace-1"],
        }),
      });
      const render = () => {
        const location = router.state.location;
        window.history.replaceState(null, "", location.href);
        const context: AdminRouterContext = {
          ...getAdminRouteState({ pathname: location.pathname, search: location.searchStr }),
          currentSearch: location.searchStr,
          defaultRedirectTarget: null,
          guildDirectory: [],
          guildLookupError: null,
          guildResourcesRefreshVersion: 0,
          onSelectedGuildChange: () => {},
          refreshGuildDirectory: async () => {},
          onRefresh: async () => {},
          playstationLinkEnabled: true,
          workerVersion: "worker-test",
          entitlement: null,
          userProfile: { name: "Alex Morgan", email: "", image: "" },
          userPreferences: DEFAULT_USER_PREFERENCES,
          applyUserPreferencesPatch: async () => {},
          pageMetadata: null,
          setPageMetadata: () => {},
          isRoutePending: false,
        };
        root.render(
          <AdminRouteContextProvider value={context}>
            {/* Node's router entry does not subscribe. Remount its renderer to exercise the shell's route lifetime. */}
            <RouterProvider key={location.href} router={router} />
          </AdminRouteContextProvider>,
        );
      };
      const openFeedback = async () => {
        const trigger = container.querySelector<HTMLButtonElement>(
          '[aria-label="Open account menu for Alex Morgan"]',
        );
        assert.ok(trigger);
        await act(async () => trigger.click());
        await click("Send feedback", container.querySelector('[role="menu"]')!);
        return trigger;
      };
      const summary = () =>
        document.querySelector<HTMLInputElement>(
          '[role="alertdialog"] input:not([type="checkbox"])',
        )!;
      const preview = () =>
        document.querySelector('[aria-label="Feedback context preview"]')?.textContent;
      const submissions: Array<Record<string, unknown>> = [];
      globalThis.fetch = async (input, init) => {
        assert.equal(input, "/admin/api/feedback");
        submissions.push(JSON.parse(String(init?.body)));
        return Response.json(
          { ok: true, reference: "FB-navigation", receivedAtMs: 1 },
          { status: 201 },
        );
      };
      await router.load();
      await act(async () => render());
      const firstShell = container.querySelector(".admin-shell-root");
      await click("Edit storefront draft");
      const trigger = await openFeedback();
      await change(summary(), "Keep my feedback draft");
      await change(document.querySelector("textarea")!, "Keep the captured Commerce context");
      await change(document.querySelector("select")!, "suggestion");
      await act(async () =>
        document.querySelector<HTMLInputElement>('input[type="checkbox"]')!.click(),
      );
      const capturedContext = preview();
      assert.match(capturedContext ?? "", /\/admin\/123\/commerce/);
      act(() => {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      await act(async () => {});
      assert.equal(document.activeElement, trigger);
      await act(async () =>
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true })),
      );
      const profileOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (element) => element.textContent?.trim() === "Profile",
      );
      assert.ok(profileOption);
      await act(async () => profileOption.click());
      assert.match(
        document.querySelector('[role="alertdialog"]')?.textContent ?? "",
        /Leave page\?/,
      );
      await click("Leave");
      // TanStack's Node entry needs an explicit load after history navigation.
      await router.load();
      await act(async () => render());
      assert.equal(router.history.location.pathname, "/admin/profile");
      assert.notEqual(container.querySelector(".admin-shell-root"), firstShell);
      assert.match(container.textContent ?? "", /Profile page/);
      for (const destination of [
        null,
        "/admin/456/commerce?workspaceId=workspace-1",
        "/admin/456/commerce?workspaceId=workspace-2",
      ]) {
        if (destination) {
          await act(async () => {
            await router.navigate({ to: destination });
            await router.load();
            render();
          });
        }
        await openFeedback();
        assert.equal(summary().value, "Keep my feedback draft");
        assert.equal(
          document.querySelector("textarea")?.value,
          "Keep the captured Commerce context",
        );
        assert.equal(document.querySelector("select")?.value, "suggestion");
        assert.equal(
          document.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked,
          true,
        );
        assert.equal(preview(), capturedContext);
        await click("Cancel");
      }
      await openFeedback();
      await click("Send feedback", document.querySelector('[role="alertdialog"]')!);
      assert.equal(submissions[0]?.route, "/admin/123/commerce");
      assert.equal(submissions[0]?.guildId, "123");
      assert.equal(submissions[0]?.workspaceId, undefined);
      await click("Close");
      await openFeedback();
      assert.equal(summary().value, "");
      assert.match(preview() ?? "", /\/admin\/456\/commerce/);
      await change(summary(), "Session-only draft");
      await click("Cancel");
      await act(async () => root.render(null));
      await act(async () => render());
      await openFeedback();
      assert.equal(summary().value, "", "an authenticated tree unmount clears its private draft");
    });
  },
);

test("feedback receipt stays visible and announces clipboard rejection and success", async () => {
  await withDom(async ({ root }) => {
    const { default: AdminFeedbackDialog } =
      await import("../src/admin/components/admin-feedback-dialog-view");
    let failCopy = true;
    const copied: string[] = [];
    await act(async () =>
      root.render(
        <AdminFeedbackDialog
          open
          snapshot={{ route: "/admin/clans" }}
          onOpenChange={() => {}}
          submitFeedback={async () => ({ ok: true, reference: "FB-456", receivedAtMs: 1 })}
          copyReceipt={async (value) => {
            if (failCopy) throw new Error("Permission denied");
            copied.push(value);
          }}
        />,
      ),
    );
    await change(
      document.querySelector('[role="alertdialog"] input:not([type="checkbox"])')!,
      "A summary",
    );
    await change(document.querySelector("textarea")!, "A description");
    await click("Send feedback");
    await click("Copy receipt");
    assert.match(
      document.querySelector('[role="alert"]')?.textContent ?? "",
      /Could not copy the receipt/,
    );
    assert.equal(document.querySelector("code")?.textContent, "FB-456");
    failCopy = false;
    await click("Copy receipt");
    assert.equal(document.querySelector('[role="alert"]'), null);
    assert.match(document.querySelector('[role="status"]')?.textContent ?? "", /Receipt copied/);
    assert.equal(document.querySelector("code")?.textContent, "FB-456");
    assert.deepEqual(copied, ["FB-456"]);
  });
});
