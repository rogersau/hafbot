import assert from "node:assert/strict";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { AdminPageHeader } from "../src/admin/components/admin-page-header";
import { withAdminDom } from "./support/admin-dom";

test("AdminPageHeader exposes readiness through the rendered setup check", async () => {
  const dom = new JSDOM("<!doctype html><html><body><div id='root'></div></body></html>", {
    url: "https://example.com/admin",
  });
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    fetch: async () =>
      Response.json({
        guildId: "guild-1",
        checksByFeature: {
          lfg: [
            {
              id: "notice-channel",
              label: "Notice channel",
              status: "warning",
              detail: "Choose a notice channel.",
            },
          ],
        },
      }),
  });
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <AdminPageHeader
          title="LFG"
          readinessFeature="lfg"
          selectedGuildId="guild-1"
          selectedWorkspaceId="workspace-1"
        />,
      );
    });
    await act(async () => undefined);

    const readiness = container.querySelector('[data-feature-readiness="lfg"]');
    assert.ok(readiness);
    assert.match(readiness.textContent ?? "", /Setup check: Notice channel/);
    assert.equal(readiness.querySelector("a")?.textContent, "Review setup");

    await act(async () => {
      root.render(<AdminPageHeader title="Billing" />);
    });
    assert.equal(container.querySelector("[data-feature-readiness]"), null);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
      fetch: previousFetch,
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});

test("Setup Check follows the current guild and the editor's dirty flag", async () => {
  await withAdminDom(async ({ render, container }) => {
    let finishOld!: (response: Response) => void;
    const old = new Promise<Response>((resolve) => {
      finishOld = resolve;
    });
    const diagnostics = (label: string) =>
      Response.json({
        checksByFeature: {
          lfg: [{ id: "notice-channel", label, status: "warning", detail: "Choose a channel." }],
        },
      });
    const requests: string[] = [];
    globalThis.fetch = async (input) => {
      const guildId = new URL(String(input), "https://example.com").searchParams.get("guildId");
      assert.ok(guildId);
      requests.push(guildId);
      return guildId === "guild-1" ? old : diagnostics("New guild check");
    };
    const header = (guildId: string, dirty = false) => (
      <AdminPageHeader
        title="LFG"
        readinessFeature="lfg"
        selectedGuildId={guildId}
        hasUnsavedChanges={dirty}
      />
    );
    await render(header("guild-1"));
    await render(header("guild-2"));
    assert.match(container.textContent ?? "", /New guild check/);
    await act(async () => finishOld(diagnostics("Old guild check")));
    assert.match(container.textContent ?? "", /New guild check/);
    assert.doesNotMatch(container.textContent ?? "", /Old guild check/);
    await render(header("guild-2", true));
    assert.match(container.textContent ?? "", /Setup check: Unsaved changes/);
    assert.ok(
      [...container.querySelectorAll("button")].find((button) =>
        /Recheck setup/.test(button.textContent ?? ""),
      )?.disabled,
    );
    assert.deepEqual(requests, ["guild-1", "guild-2"]);
  });
});
