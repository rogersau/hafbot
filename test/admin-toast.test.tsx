/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { JSDOM } from "jsdom";

import { ToastProvider, useToast } from "../src/admin/components/toast";

type ToastApi = ReturnType<typeof useToast>;

type ScheduledTimer = {
  callback: () => void;
  delay: number;
};

function createDom() {
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

  return {
    dom,
    root,
    container,
    previousWindow,
    previousDocument,
    reactActEnvironment,
    previousActEnvironment,
  };
}

function restoreDom(env: ReturnType<typeof createDom>, unmount = true) {
  if (unmount) env.root.unmount();
  Object.assign(globalThis, {
    window: env.previousWindow,
    document: env.previousDocument,
  });
  env.reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = env.previousActEnvironment;
  env.dom.window.close();
}

function installFakeTimers(env: ReturnType<typeof createDom>) {
  const originalSetTimeout = env.dom.window.setTimeout;
  const originalClearTimeout = env.dom.window.clearTimeout;
  const scheduled = new Map<number, ScheduledTimer>();
  let nextTimerId = 0;

  env.dom.window.setTimeout = ((handler: TimerHandler, delay?: number) => {
    assert.equal(typeof handler, "function");
    const id = ++nextTimerId;
    scheduled.set(id, {
      callback: handler as () => void,
      delay: Number(delay ?? 0),
    });
    return id;
  }) as typeof env.dom.window.setTimeout;

  env.dom.window.clearTimeout = ((id?: number) => {
    if (id !== undefined) scheduled.delete(Number(id));
  }) as typeof env.dom.window.clearTimeout;

  return {
    entries: () => [...scheduled.entries()],
    run(id: number) {
      const timer = scheduled.get(id);
      assert.ok(timer, `Expected timer ${id}`);
      scheduled.delete(id);
      timer.callback();
    },
    restore() {
      env.dom.window.setTimeout = originalSetTimeout;
      env.dom.window.clearTimeout = originalClearTimeout;
    },
  };
}

function ToastProbe({ capture }: { capture: (api: ToastApi) => void }) {
  capture(useToast());
  return null;
}

async function renderProvider(env: ReturnType<typeof createDom>): Promise<ToastApi> {
  let captured: ToastApi | null = null;
  await act(async () => {
    env.root.render(
      <ToastProvider>
        <ToastProbe capture={(api) => (captured = api)} />
      </ToastProvider>,
    );
  });
  assert.ok(captured);
  return captured;
}

function getToastRegions(document: Document): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-toast-id]")];
}

function getToastMessages(document: Document): string[] {
  return getToastRegions(document).map((region) => region.textContent?.trim() ?? "");
}

async function show(action: () => void) {
  await act(async () => {
    action();
  });
}

test("ToastProvider renders one toast with polite status semantics", async () => {
  const env = createDom();
  const timers = installFakeTimers(env);

  try {
    const toast = await renderProvider(env);
    await show(() => toast.success("Saved"));

    const regions = getToastRegions(env.dom.window.document);
    assert.equal(regions.length, 1);
    assert.equal(regions[0]?.textContent?.trim(), "Saved");
    assert.equal(regions[0]?.getAttribute("role"), "status");
    assert.equal(regions[0]?.getAttribute("aria-live"), "polite");
    assert.equal(regions[0]?.querySelector("button")?.getAttribute("role"), null);
    assert.deepEqual(
      timers.entries().map(([, timer]) => timer.delay),
      [4000],
    );
  } finally {
    timers.restore();
    restoreDom(env);
  }
});

test("rapid toasts remain visible with newest first and distinct monotonic IDs", async () => {
  const env = createDom();
  const timers = installFakeTimers(env);
  const previousDateNow = Date.now;
  Date.now = () => 1_700_000_000_000;

  try {
    const toast = await renderProvider(env);
    await show(() => {
      toast.success("First");
      toast.info("Second");
    });

    assert.deepEqual(getToastMessages(env.dom.window.document), ["Second", "First"]);
    const ids = getToastRegions(env.dom.window.document).map((region) =>
      region.getAttribute("data-toast-id"),
    );
    assert.equal(new Set(ids).size, 2);
    assert.deepEqual(ids, ["2", "1"]);
  } finally {
    Date.now = previousDateNow;
    timers.restore();
    restoreDom(env);
  }
});

test("clicking one toast dismisses only that toast", async () => {
  const env = createDom();
  const timers = installFakeTimers(env);

  try {
    const toast = await renderProvider(env);
    await show(() => {
      toast.success("Keep me");
      toast.info("Dismiss me");
    });

    const dismissButton = [...env.container.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Dismiss me",
    );
    assert.ok(dismissButton);
    await act(async () => {
      dismissButton.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    assert.deepEqual(getToastMessages(env.dom.window.document), ["Keep me"]);
    assert.equal(timers.entries().length, 1);
  } finally {
    timers.restore();
    restoreDom(env);
  }
});

test("each toast dismisses from its own four-second timeout", async () => {
  const env = createDom();
  const timers = installFakeTimers(env);

  try {
    const toast = await renderProvider(env);
    await show(() => {
      toast.success("One");
      toast.info("Two");
    });

    const entries = timers.entries();
    assert.equal(entries.length, 2);
    assert.equal(
      entries.every(([, timer]) => timer.delay === 4000),
      true,
    );

    await act(async () => timers.run(entries[0]![0]));
    assert.deepEqual(getToastMessages(env.dom.window.document), ["Two"]);

    await act(async () => timers.run(entries[1]![0]));
    assert.deepEqual(getToastMessages(env.dom.window.document), []);
  } finally {
    timers.restore();
    restoreDom(env);
  }
});

test("a fourth toast removes only the oldest active toast and timer", async () => {
  const env = createDom();
  const timers = installFakeTimers(env);

  try {
    const toast = await renderProvider(env);
    await show(() => {
      toast.success("One");
      toast.success("Two");
      toast.info("Three");
      toast.error("Four");
    });

    assert.deepEqual(getToastMessages(env.dom.window.document), ["Four", "Three", "Two"]);
    assert.equal(timers.entries().length, 3);
  } finally {
    timers.restore();
    restoreDom(env);
  }
});

test("error toasts use assertive alert semantics while success and info remain polite", async () => {
  const env = createDom();
  const timers = installFakeTimers(env);

  try {
    const toast = await renderProvider(env);
    await show(() => {
      toast.success("Saved");
      toast.info("Copied");
      toast.error("Failed");
    });

    const regions = getToastRegions(env.dom.window.document);
    const error = regions.find((region) => region.textContent?.trim() === "Failed");
    const nonErrors = regions.filter((region) => region !== error);
    assert.ok(error);
    assert.equal(error.getAttribute("role"), "alert");
    assert.equal(error.getAttribute("aria-live"), "assertive");
    assert.equal(
      nonErrors.every(
        (region) =>
          region.getAttribute("role") === "status" && region.getAttribute("aria-live") === "polite",
      ),
      true,
    );
  } finally {
    timers.restore();
    restoreDom(env);
  }
});

test("ToastProvider clears scheduled timers when it unmounts", async () => {
  const env = createDom();
  const timers = installFakeTimers(env);

  try {
    const toast = await renderProvider(env);
    await show(() => {
      toast.success("One");
      toast.info("Two");
    });
    assert.equal(timers.entries().length, 2);

    await act(async () => env.root.unmount());
    assert.equal(timers.entries().length, 0);
  } finally {
    timers.restore();
    restoreDom(env, false);
  }
});

test("useToast without a provider remains a harmless no-op", () => {
  assert.doesNotThrow(() => {
    const html = renderToString(
      <ToastProbe
        capture={(toast) => {
          toast.success("saved");
          toast.error("failed");
          toast.info("info");
        }}
      />,
    );
    assert.equal(html, "");
  });
});
