/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile via tsconfig.tests.json.
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { AdminPageHeader } from "../src/admin/components/admin-page-header";

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
