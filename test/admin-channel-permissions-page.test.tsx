/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Tests compile via tsconfig.tests.json; admin React is excluded from the runtime test build.
import test from "node:test";
import { JSDOM } from "jsdom";
import { act, StrictMode } from "react";

import { renderToString } from "react-dom/server";

import {
  transitionPermissionCopy,
  permissionCopyNeedsRefresh,
} from "../src/admin/lib/permission-copy-workflow";
import { withAdminDom } from "./support/admin-dom";

const resources = {
  channels: [
    { id: "source", name: "staff", type: "text", categoryName: "Operations" },
    { id: "target", name: "private", type: "forum", categoryName: "Operations" },
    { id: "new-target", name: "leadership", type: "text", categoryName: "Operations" },
  ],
};

test("channel loading admits one retry before React renders", async () => {
  await withAdminDom(async ({ render, container }) => {
    const { AdminChannelPermissionsPage } =
      await import("../src/admin/components/admin-channel-permissions-page");
    let reads = 0;
    let finish: ((response: Response) => void) | undefined;
    globalThis.fetch = async () => {
      reads++;
      if (reads === 1) throw new Error("Read unavailable");
      return new Promise<Response>((resolve) => {
        finish = resolve;
      });
    };
    await render(<AdminChannelPermissionsPage selectedWorkspaceId="" selectedGuildId="guild-1" />);
    await act(async () => {
      const retry = findButton(container, "Retry loading channels");
      retry.click();
      retry.click();
    });
    assert.equal(reads, 2);
    assert.doesNotMatch(container.textContent ?? "", /Read unavailable/);
    await act(async () => {
      finish!(Response.json(resources));
    });
    assert.equal(container.querySelectorAll("#permission-source option").length, 4);
    assert.doesNotMatch(container.textContent ?? "", /Loading supported/);
  });
});

for (const obsolete of ["success", "failure"] as const) {
  test(`superseded channel read ${obsolete} cannot overwrite the current resources`, async () => {
    await withAdminDom(async ({ render, container }) => {
      const { AdminChannelPermissionsPage } =
        await import("../src/admin/components/admin-channel-permissions-page");
      const pending: Array<{
        resolve: (response: Response) => void;
        reject: (cause: Error) => void;
      }> = [];
      globalThis.fetch = () =>
        new Promise<Response>((resolve, reject) => {
          pending.push({ resolve, reject });
        });
      // Strict Mode replays mount setup/cleanup, leaving the first network read in flight.
      await render(
        <StrictMode>
          <AdminChannelPermissionsPage selectedWorkspaceId="" selectedGuildId="guild-1" />
        </StrictMode>,
      );
      assert.equal(pending.length, 2);
      await act(async () => {
        pending[1]!.resolve(Response.json(resources));
      });
      await act(async () => {
        if (obsolete === "success") pending[0]!.resolve(Response.json({ channels: [] }));
        else pending[0]!.reject(new Error("Obsolete read failure"));
      });
      assert.equal(container.querySelectorAll("#permission-source option").length, 4);
      assert.doesNotMatch(
        container.textContent ?? "",
        /Obsolete read failure|Loading supported|Retry loading/,
      );
    });
  });
}

for (const failure of ["resources", "route", "apply"] as const) {
  test(`permission copy recovers ${failure} failure without repeating a confirmed apply`, async () => {
    await withAdminDom(async ({ render, click, container }) => {
      const { AdminChannelPermissionsPage } =
        await import("../src/admin/components/admin-channel-permissions-page");
      let applies = 0;
      let reads = 0;
      let routeRefreshes = 0;
      let releaseRefresh: (() => void) | undefined;
      globalThis.fetch = async (input) => {
        const path = String(input);
        if (path.includes("/preview")) return previewResponse("target", "token");
        if (path.includes("/apply")) {
          applies++;
          return failure === "apply"
            ? Response.json({ error: "Response lost" }, { status: 502 })
            : Response.json({});
        }
        reads++;
        if (failure === "resources" && reads === 1) throw new Error("Read unavailable");
        if (reads === 2)
          await new Promise<void>((resolve) => {
            releaseRefresh = resolve;
          });
        return Response.json(resources);
      };
      await render(
        <AdminChannelPermissionsPage
          selectedWorkspaceId="workspace-1"
          selectedGuildId="guild-1"
          initialData={resources}
          onRouteDataRefresh={async () => {
            routeRefreshes++;
            if (failure === "route" && routeRefreshes === 1) throw new Error("Route unavailable");
          }}
        />,
      );
      await changeSelect(container, "permission-source", "source");
      await changeSelect(container, "permission-target", "target");
      await click("Preview changes");
      const input = container.querySelector<HTMLInputElement>("#target-confirmation")!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "private",
        );
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      assert.equal(findButton(container, "Copy permissions to #private").disabled, false);
      await act(async () => {
        const button = findButton(container, "Copy permissions to #private");
        button.click();
        button.click();
      });
      assert.equal(applies, 1);
      assert.equal(container.querySelector("#target-confirmation"), null);
      if (failure === "apply") {
        assert.doesNotMatch(container.textContent ?? "", /Permissions copied/);
        assert.equal(reads, 0);
        assert.equal(findButton(container, "Preview changes").disabled, false);
        return;
      }
      assert.match(
        container.textContent ?? "",
        /Permissions were copied, but the page could not refresh/,
      );
      assert.equal(findButton(container, "Preview changes").disabled, true);
      await act(async () => {
        const button = findButton(container, "Retry refresh");
        button.click();
        button.click();
      });
      assert.ok(releaseRefresh);
      assert.equal(findButton(container, "Preview changes").disabled, true);
      await act(async () => {
        releaseRefresh!();
      });
      assert.equal(applies, 1);
      assert.equal(reads, 2);
      assert.doesNotMatch(container.textContent ?? "", /could not refresh/);
      assert.equal(findButton(container, "Preview changes").disabled, false);
      await click("Preview changes");
      assert.doesNotMatch(container.textContent ?? "", /Permissions copied/);
    });
  });
}

// Characterize the current recovery boundary; these are not durable recovery guarantees.
for (const checkpoint of ["applying", "refreshing", "refresh-failed"] as const) {
  test(`permission copy remount at ${checkpoint} loses local recovery without replaying apply`, async () => {
    await withAdminDom(async ({ render, click, container }) => {
      const { AdminChannelPermissionsPage } =
        await import("../src/admin/components/admin-channel-permissions-page");
      let applies = 0;
      let reads = 0;
      let routeRefreshes = 0;
      let finish: ((response: Response) => void) | undefined;
      globalThis.fetch = async (input) => {
        const path = String(input);
        if (path.includes("/preview")) return previewResponse("target", "token");
        if (path.includes("/apply")) {
          applies++;
          if (checkpoint !== "applying") return Response.json({});
        } else {
          reads++;
          if (checkpoint === "refresh-failed") throw new Error("Refresh unavailable");
          if (checkpoint !== "refreshing") return Response.json(resources);
        }
        return new Promise<Response>((resolve) => {
          finish = resolve;
        });
      };
      const page = (key: string) => (
        <AdminChannelPermissionsPage
          key={key}
          selectedWorkspaceId=""
          selectedGuildId="guild-1"
          initialData={resources}
          onRouteDataRefresh={async () => {
            routeRefreshes++;
          }}
        />
      );
      await render(page("original"));
      await changeSelect(container, "permission-source", "source");
      await changeSelect(container, "permission-target", "target");
      await click("Preview changes");
      await act(async () => {
        const input = container.querySelector<HTMLInputElement>("#target-confirmation")!;
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(
          input,
          "private",
        );
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await click("Copy permissions to #private");
      assert.equal(applies, 1);
      assert.equal(reads, checkpoint === "applying" ? 0 : 1);
      if (checkpoint !== "applying")
        assert.match(container.textContent ?? "", /Permissions copied/);
      if (checkpoint === "refresh-failed") assert.ok(findButton(container, "Retry refresh"));

      // A changed React key destroys the original instance, as route remounts do.
      await render(page("replacement"));
      assert.equal(container.querySelector("#target-confirmation"), null);
      assert.doesNotMatch(container.textContent ?? "", /Permissions copied|Retry refresh/);
      await changeSelect(container, "permission-source", "source");
      await changeSelect(container, "permission-target", "target");
      assert.equal(findButton(container, "Preview changes").disabled, false);
      assert.equal(applies, 1);

      if (finish) {
        await act(async () => {
          finish!(Response.json(resources));
        });
        // The detached continuation still refreshes route data; its state is not recovered.
        assert.equal(routeRefreshes, 1);
        assert.doesNotMatch(container.textContent ?? "", /Permissions copied|Retry refresh/);
        assert.equal(findButton(container, "Preview changes").disabled, false);
        assert.equal(applies, 1);
      } else assert.equal(routeRefreshes, 0);
    });
  });
}

test("confirmed copy cannot re-enter apply or preview before refresh completes", () => {
  let state = transitionPermissionCopy("idle", "apply-started");
  state = transitionPermissionCopy(state, "apply-committed");
  for (const event of [
    "apply-started",
    "apply-failed",
    "preview-started",
    "refresh-started",
  ] as const)
    assert.equal(transitionPermissionCopy(state, event), "refreshing");
  state = transitionPermissionCopy(state, "refresh-failed");
  assert.equal(permissionCopyNeedsRefresh(state), true);
  assert.equal(transitionPermissionCopy(state, "apply-started"), "refresh-failed");
  assert.equal(transitionPermissionCopy(state, "preview-started"), "refresh-failed");
  state = transitionPermissionCopy(state, "refresh-started");
  state = transitionPermissionCopy(state, "refresh-completed");
  assert.equal(state, "committed");
  assert.equal(permissionCopyNeedsRefresh(state), false);
  assert.equal(transitionPermissionCopy(state, "preview-started"), "idle");
});

test("channel permissions shell defaults to the safer role-only mode and groups channels", async () => {
  const { AdminChannelPermissionsPage } =
    await import("../src/admin/components/admin-channel-permissions-page");
  const html = renderToString(
    <AdminChannelPermissionsPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={resources}
    />,
  );

  assert.match(html, /Copy only Discord channel permission overwrites/);
  assert.match(html, /<optgroup label="Operations">/);
  assert.match(html, /checked="" value="roles_only"/);
  assert.match(html, /Role permissions only/);
  assert.match(html, /Exact copy can remove|may remove individual member access/);
  assert.match(html, /adds HAF Bot recovery access if needed/);
  assert.match(html, /Preview changes/);
});

test("preview sections are declared in safety order", async () => {
  const { CHANNEL_PERMISSION_PREVIEW_SECTION_ORDER } =
    await import("../src/admin/components/admin-channel-permissions-page");
  assert.deepEqual(CHANNEL_PERMISSION_PREVIEW_SECTION_ORDER, ["blockers", "warnings", "changes"]);
});

test("an obsolete in-flight preview cannot replace the preview for changed selections", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://example.com/admin",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const previousRequestAnimationFrame = globalThis.requestAnimationFrame;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(callback, 0),
  });

  const responses: Array<(response: Response) => void> = [];
  globalThis.fetch = () =>
    new Promise<Response>((resolve) => {
      responses.push(resolve);
    });

  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const { createRoot } = await import("react-dom/client");
  const { AdminChannelPermissionsPage } =
    await import("../src/admin/components/admin-channel-permissions-page");
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <AdminChannelPermissionsPage
          selectedWorkspaceId="workspace-1"
          selectedGuildId="guild-1"
          initialData={resources}
        />,
      );
    });

    await changeSelect(container, "permission-source", "source");
    await changeSelect(container, "permission-target", "target");
    await act(async () => findButton(container, "Preview changes").click());
    assert.equal(responses.length, 1);

    await changeSelect(container, "permission-target", "new-target");
    await act(async () => findButton(container, "Preview changes").click());
    assert.equal(responses.length, 2);

    await act(async () => {
      responses[0]!(previewResponse("target", "obsolete-token"));
      await Promise.resolve();
    });
    assert.doesNotMatch(container.textContent ?? "", /Permission preview for #private/);
    assert.ok(findButton(container, "Generating preview..."));

    await act(async () => {
      responses[1]!(previewResponse("new-target", "current-token"));
      await Promise.resolve();
    });
    assert.match(container.textContent ?? "", /Permission preview for #leadership/);
    assert.doesNotMatch(container.textContent ?? "", /Permission preview for #private/);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      fetch: previousFetch,
      requestAnimationFrame: previousRequestAnimationFrame,
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});

async function changeSelect(container: Element, id: string, value: string): Promise<void> {
  const select = container.querySelector(`#${id}`) as HTMLSelectElement | null;
  assert.ok(select);
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

function findButton(container: Element, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll("button")).find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  assert.ok(button, `Expected ${label} button`);
  return button as HTMLButtonElement;
}

function previewResponse(targetId: string, previewToken: string): Response {
  return Response.json({
    previewToken,
    expiresAt: "2026-07-28T01:00:00.000Z",
    source: resources.channels[0],
    target: resources.channels.find((channel) => channel.id === targetId),
    mode: "roles_only",
    changes: [],
    blockers: [],
    warnings: [],
  });
}
