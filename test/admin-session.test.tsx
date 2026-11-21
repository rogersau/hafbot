import assert from "node:assert/strict";
import test from "node:test";
import { AdminRefreshNoticeHost } from "../src/admin/components/admin-refresh-notice-host";
import { ToastProvider } from "../src/admin/components/toast";
import { createAdminRead } from "../src/admin/lib/admin-read";
import {
  AdminSessionProvider,
  useAdminRouteRefresh,
  useAdminSession,
  useAdminSessionState,
} from "../src/admin/lib/admin-session";
import { withAdminDom } from "./support/admin-dom";

function SessionControl({ name }: { name: string }) {
  const session = useAdminSession();
  const collapsed = useAdminSessionState((state) => state.sidebarCollapsed);
  return (
    <button
      type="button"
      aria-pressed={collapsed}
      onClick={() => session.update({ sidebarCollapsed: !collapsed })}
    >
      {name}
    </button>
  );
}

test("A cached Admin read revalidates when revisited and shares the request with other observers", async () => {
  let requests = 0;
  const read = createAdminRead(async () => ++requests, true);
  const first = read.subscribe(() => {});
  assert.equal(await read.ensure(), 1);
  first();

  const revisit = read.subscribe(() => {});
  const concurrent = read.subscribe(() => {});
  try {
    assert.equal(read.getSnapshot().loading, true);
    assert.equal(await read.ensure(), 2);
    assert.equal(requests, 2);
  } finally {
    revisit();
    concurrent();
  }
});

test("Admin session state survives view remounts and is isolated between dashboards", async () => {
  await withAdminDom(async ({ render, click, container }) => {
    function view(page: string) {
      return (
        <>
          <AdminSessionProvider>
            <AdminSessionProvider>
              <SessionControl key={page} name={page} />
            </AdminSessionProvider>
          </AdminSessionProvider>
          <AdminSessionProvider>
            <SessionControl name="Other dashboard" />
          </AdminSessionProvider>
        </>
      );
    }
    await render(view("Overview"));
    await click("Overview");
    await render(view("Tickets"));
    const buttons = container.querySelectorAll("button");
    assert.equal(buttons[0]?.textContent, "Tickets");
    assert.equal(buttons[0]?.getAttribute("aria-pressed"), "true");
    assert.equal(buttons[1]?.getAttribute("aria-pressed"), "false");
  });
});

test("Admin refresh failures and retries belong to the session that requested the refresh", async () => {
  let attempts = 0;
  async function refresh() {
    if (++attempts === 1) throw new Error("Refresh unavailable");
  }
  function Trigger() {
    const { refreshAdminRouteData } = useAdminRouteRefresh();
    return <button onClick={() => void refreshAdminRouteData(refresh)}>Save change</button>;
  }

  await withAdminDom(async ({ render, click, container }) => {
    await render(
      <>
        <div data-session="primary">
          <ToastProvider>
            <Trigger />
            <AdminRefreshNoticeHost />
          </ToastProvider>
        </div>
        <div data-session="other">
          <ToastProvider>
            <AdminRefreshNoticeHost />
          </ToastProvider>
        </div>
      </>,
    );
    await click("Save change");
    const primary = container.querySelector('[data-session="primary"]');
    const other = container.querySelector('[data-session="other"]');
    assert.match(primary?.textContent ?? "", /Refresh unavailable/);
    assert.ok(primary?.querySelector("[data-toast-id]"));
    assert.doesNotMatch(other?.textContent ?? "", /Refresh unavailable|Retry refresh/);
    await click("Retry refresh");
    assert.equal(attempts, 2);
    assert.doesNotMatch(primary?.textContent ?? "", /Retry refresh/);
  });
});
