/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";

import { useAdminApi } from "../src/admin/hooks/use-admin-api";
import { withAdminDom } from "./support/admin-dom";

test("cancelling an admin request exits loading and rejects its late completion", async () => {
  await withAdminDom(async (ui) => {
    let api!: ReturnType<typeof useAdminApi>;
    function Probe() {
      api = useAdminApi();
      return <span>{api.state.kind}</span>;
    }
    await ui.render(<Probe />);
    let finish!: () => void;
    let completed = false;
    let request!: Promise<void>;
    await act(async () => {
      request = api.run(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
        () => {
          completed = true;
        },
      );
    });
    assert.equal(api.loading, true);
    await act(async () => api.cancel());
    assert.equal(api.loading, false);
    await act(async () => {
      finish();
      await request;
    });
    assert.equal(completed, false);
    assert.equal(api.state.kind, "cancelled");
  });
});

test("a throwing error reporter cannot leave an admin request running", async () => {
  await withAdminDom(async (ui) => {
    let api!: ReturnType<typeof useAdminApi>;
    function Probe() {
      api = useAdminApi();
      return null;
    }
    await ui.render(<Probe />);
    await act(async () => {
      await assert.rejects(
        api.run(
          async () => {
            throw new Error("request failed");
          },
          undefined,
          () => {
            throw new Error("report failed");
          },
        ),
        /report failed/,
      );
    });
    assert.equal(api.loading, false);
    assert.equal(api.state.kind, "failed");
  });
});

test("an admin action can report a transient failure without creating inline page feedback", async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const previousWindow = globalThis.window;
  const previousDocument = globalThis.document;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });

  const container = dom.window.document.querySelector("#root");
  assert.ok(container);
  const root = createRoot(container);
  let reported = "";

  function Probe() {
    const api = useAdminApi();
    return (
      <>
        <button
          type="button"
          onClick={() =>
            void api.run(
              async () => {
                throw new Error("Discord rejected the action.");
              },
              undefined,
              (message) => {
                reported = message;
              },
            )
          }
        >
          Run action
        </button>
        <span data-inline-error>{api.error}</span>
      </>
    );
  }

  try {
    await act(async () => root.render(<Probe />));
    const button = container.querySelector<HTMLButtonElement>("button");
    assert.ok(button);

    await act(async () => {
      button.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    assert.equal(reported, "Discord rejected the action.");
    assert.equal(container.querySelector("[data-inline-error]")?.textContent, "");
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, { window: previousWindow, document: previousDocument });
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
    dom.window.close();
  }
});
