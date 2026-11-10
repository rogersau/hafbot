import assert from "node:assert/strict";
import test from "node:test";
import { act, useState } from "react";
import type { Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { changeValue } from "./support/admin-dom-events";
import {
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useRouterState,
} from "@tanstack/react-router";

import { AdminTabs } from "../src/admin/components/admin-tabs";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../src/admin/components/ui/tabs";

async function withDom(run: (root: Root, container: HTMLElement) => Promise<void>) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: "https://example.com/" });
  const globals = {
    window: dom.window,
    self: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    NodeFilter: dom.window.NodeFilter,
    DocumentFragment: dom.window.DocumentFragment,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    Event: dom.window.Event,
    getComputedStyle: dom.window.getComputedStyle,
    KeyboardEvent: dom.window.KeyboardEvent,
    fetch: globalThis.fetch,
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  const previous = new Map(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals)) {
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const container = document.querySelector<HTMLElement>("#root")!;
  // React DOM must detect the browser environment before its first import.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  try {
    await run(root, container);
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

async function key(target: HTMLElement, name: string, prevented = true) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  await act(async () => target.dispatchEvent(event));
  assert.equal(event.defaultPrevented, prevented);
}

function assertTab(container: HTMLElement, label: string, selected = label) {
  const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  const focused = tabs.find((tab) => tab.textContent === label)!;
  assert.ok(document.activeElement === focused, `${label} has keyboard focus`);
  assert.deepEqual(
    tabs.filter((tab) => tab.tabIndex === 0),
    [focused],
  );
  assert.equal(
    tabs.find((tab) => tab.getAttribute("aria-selected") === "true")?.textContent,
    selected,
  );
  return focused;
}

for (const kind of ["admin", "primitive"] as const) {
  test(`${kind} tabs navigate, wrap, skip disabled tabs and retain one tab stop`, async () => {
    await withDom(async (root, container) => {
      function Harness() {
        const [selected, setSelected] = useState("first");
        if (kind === "admin")
          return (
            <>
              <AdminTabs
                tabs={[
                  { id: "first", label: "First" },
                  { id: "disabled", label: "Disabled", disabled: true },
                  { id: "last", label: "Last" },
                ]}
                activeTab={selected}
                onTabChange={setSelected}
                ariaLabel="Test"
              />
              <p role="tabpanel">{selected}</p>
            </>
          );
        return (
          <Tabs value={selected} onValueChange={setSelected}>
            <TabsList aria-label="Test">
              <TabsTrigger value="first">First</TabsTrigger>
              <TabsTrigger value="disabled" disabled>
                Disabled
              </TabsTrigger>
              <TabsTrigger value="last">Last</TabsTrigger>
            </TabsList>
            <TabsContent value="first">first</TabsContent>
            <TabsContent value="last">last</TabsContent>
          </Tabs>
        );
      }
      await act(async () => root.render(<Harness />));
      const first = container.querySelector<HTMLButtonElement>('[role="tab"]')!;
      assert.equal(first.tabIndex, 0);
      await act(async () => first.focus());
      await key(first, "ArrowRight");
      let target = assertTab(container, "Last");
      assert.equal(container.querySelector('[role="tabpanel"]')?.textContent, "last");
      await key(target, "ArrowRight");
      target = assertTab(container, "First");
      await key(target, "ArrowLeft");
      target = assertTab(container, "Last");
      await key(target, "Home");
      target = assertTab(container, "First");
      await key(target, "End");
      target = assertTab(container, "Last");
      await key(target, "ArrowDown", false);
      await key(target, "Tab", false);
      assertTab(container, "Last");
    });
  });

  test(`${kind} tabs provide an enabled fallback when the selection is disabled or missing`, async () => {
    await withDom(async (root, container) => {
      function render(selected: string, disableLast = false) {
        return kind === "admin" ? (
          <AdminTabs
            tabs={[
              { id: "disabled", label: "Disabled", disabled: true },
              { id: "last", label: "Last", disabled: disableLast },
            ]}
            activeTab={selected}
            onTabChange={() => undefined}
            ariaLabel="Test"
          />
        ) : (
          <Tabs value={selected}>
            <TabsList>
              <TabsTrigger value="disabled" disabled>
                Disabled
              </TabsTrigger>
              <TabsTrigger value="last" disabled={disableLast}>
                Last
              </TabsTrigger>
            </TabsList>
          </Tabs>
        );
      }
      for (const selected of ["disabled", "missing"]) {
        await act(async () => root.render(render(selected)));
        const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
        assert.equal(tabs[0].tabIndex, -1);
        assert.equal(tabs[1].tabIndex, 0);
      }
      await act(async () => root.render(render("disabled", true)));
      assert.equal(container.querySelector('[tabindex="0"]'), null);
    });
  });
}

test("uncontrolled primitive tabs activate on click and honor the existing vertical list attribute", async () => {
  await withDom(async (root, container) => {
    await act(async () =>
      root.render(
        <Tabs defaultValue="first">
          <TabsList aria-orientation="vertical">
            <TabsTrigger value="first">First</TabsTrigger>
            <TabsTrigger value="last">Last</TabsTrigger>
          </TabsList>
          <TabsContent value="first">first</TabsContent>
          <TabsContent value="last">last</TabsContent>
        </Tabs>,
      ),
    );
    const first = container.querySelector<HTMLButtonElement>('[role="tab"]')!;
    await act(async () => first.focus());
    await key(first, "ArrowDown");
    await key(assertTab(container, "Last"), "ArrowUp");
    await key(assertTab(container, "First"), "ArrowRight", false);
    const last = container.querySelectorAll<HTMLButtonElement>('[role="tab"]')[1];
    await act(async () => last.click());
    assert.equal(last.getAttribute("aria-selected"), "true");
    assert.equal(container.querySelector('[role="tabpanel"]')?.textContent, "last");
  });
});

test("cancelled route navigation keeps tab selection and keyboard focus usable", async () => {
  await withDom(async (root, container) => {
    const { NavigationGuard } = await import("../src/admin/components/navigation-guard");
    function Harness() {
      const selected = useRouterState({ select: (state) => state.location.pathname.slice(1) });
      const navigate = useNavigate();
      return (
        <>
          <NavigationGuard hasChanges />
          <AdminTabs
            tabs={[
              { id: "first", label: "First" },
              { id: "last", label: "Last" },
            ]}
            activeTab={selected}
            onTabChange={(tab) => {
              void navigate({ to: `/${tab}` });
            }}
            ariaLabel="Guarded"
          />
          <p role="tabpanel">{selected} draft</p>
        </>
      );
    }
    const rootRoute = createRootRoute();
    const route = createRoute({
      getParentRoute: () => rootRoute,
      path: "/$tab",
      component: Harness,
    });
    const router = createRouter({
      routeTree: rootRoute.addChildren([route]),
      history: createMemoryHistory({ initialEntries: ["/first"] }),
    });
    await router.load();
    await act(async () => root.render(<RouterProvider router={router} />));
    const first = container.querySelector<HTMLButtonElement>('[role="tab"]')!;
    await act(async () => first.focus());
    await key(first, "ArrowRight");
    const stay = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Stay",
    );
    assert.ok(stay, "the actual route blocker asks before leaving");
    await act(async () => {
      stay.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(router.state.location.pathname, "/first");
    assert.equal(container.querySelector('[role="tabpanel"]')?.textContent, "first draft");
    const last = assertTab(container, "Last", "First");
    await key(last, "Home");
    assertTab(container, "First");
    await key(first, "End");
    const leave = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Leave",
    )!;
    await act(async () => {
      leave.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // The router's Node entry does not mount a browser history subscriber.
    assert.equal(router.history.location.pathname, "/last");
    assert.equal(document.querySelector('[role="alertdialog"]'), null);
  });
});

test("Managed Messages keeps its draft and a usable tab stop after cancelling keyboard navigation", async () => {
  await withDom(async (root, container) => {
    const { AdminManagedMessagesPage } =
      await import("../src/admin/components/admin-managed-messages-page");
    globalThis.fetch = async () =>
      Response.json({ guildId: "guild-1", checksByFeature: { "managed-messages": [] } });
    await act(async () =>
      root.render(
        <AdminManagedMessagesPage
          selectedWorkspaceId="workspace-1"
          selectedGuildId="guild-1"
          initialData={{
            guildId: "guild-1",
            messages: [],
            entitlement: null,
            canWrite: true,
            resources: {
              guildId: "guild-1",
              roles: [],
              categories: [],
              textChannels: [],
              voiceChannels: [],
              forumChannels: [],
            },
          }}
        />,
      ),
    );
    const messages = container.querySelector<HTMLButtonElement>('[role="tab"]')!;
    await act(async () => messages.focus());
    await key(messages, "ArrowRight");
    const editor = assertTab(container, "Create Message");
    const name = container.querySelector<HTMLInputElement>("#managed-message-name")!;
    await act(async () => {
      changeValue(name, "Keep this draft");
    });
    await key(editor, "ArrowLeft");
    const dialog = document.querySelector('[role="alertdialog"]');
    assert.ok(dialog, "the actual editor guard asks before leaving");
    const keepEditing = [...dialog.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Keep editing",
    )!;
    await act(async () => {
      keepEditing.click();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.equal(name.value, "Keep this draft");
    assertTab(container, "Existing Messages", "Create Message");
    await key(messages, "ArrowRight");
    assertTab(container, "Create Message");
    assert.equal(name.value, "Keep this draft");
  });
});
