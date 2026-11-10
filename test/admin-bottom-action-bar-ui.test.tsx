/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import {
  AdminBottomActionBar,
  AdminBottomActionBarProvider,
} from "../src/admin/components/admin-bottom-action-bar";

test("admin bottom action bar portals out of page content into the shell host", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const reactActEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = reactActEnvironment.IS_REACT_ACT_ENVIRONMENT;
  reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
  });
  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);

  try {
    await act(async () => {
      root.render(
        <div className="admin-shell-content">
          <AdminBottomActionBarProvider>
            <main className="admin-shell-main">
              <section className="admin-feature-page">
                <AdminBottomActionBar actions={[{ label: "Save changes", onClick: () => {} }]} />
              </section>
            </main>
          </AdminBottomActionBarProvider>
        </div>,
      );
    });

    const main = container.querySelector(".admin-shell-main");
    const host = container.querySelector(".admin-bottom-action-bar-host");
    const bar = container.querySelector(".admin-bottom-action-bar");
    assert.ok(main);
    assert.ok(host);
    assert.ok(bar);
    assert.equal(main.querySelector(".admin-bottom-action-bar"), null);
    assert.equal(bar.parentElement, host);
    assert.match(host.textContent ?? "", /Save changes/);
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, {
      window: previousWindow,
      document: previousDocument,
    });
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});
