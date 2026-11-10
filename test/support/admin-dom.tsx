import assert from "node:assert/strict";
import { act, type ReactNode } from "react";
import { JSDOM } from "jsdom";

/** Install browser globals before importing Radix components, and restore them after unmount. */
export async function withAdminDom(
  run: (ui: {
    container: Element;
    render: (element: ReactNode) => Promise<void>;
    click: (label: string) => Promise<void>;
  }) => Promise<void>,
) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', {
    url: "https://example.com/admin",
  });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    Element: dom.window.Element,
    HTMLElement: dom.window.HTMLElement,
    HTMLFormElement: dom.window.HTMLFormElement,
    HTMLInputElement: dom.window.HTMLInputElement,
    Node: dom.window.Node,
    DocumentFragment: dom.window.DocumentFragment,
    NodeFilter: dom.window.NodeFilter,
    MutationObserver: dom.window.MutationObserver,
    CustomEvent: dom.window.CustomEvent,
    getComputedStyle: dom.window.getComputedStyle,
    self: dom.window,
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
  const previous = Object.fromEntries(
    Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const container = dom.window.document.querySelector("#root")!;
  // React DOM must detect the browser environment before its first import.
  const { createRoot } = await import("react-dom/client");
  const root = createRoot(container);
  try {
    await run({
      container,
      render: async (element) => {
        await act(async () => root.render(element));
      },
      click: async (label) => {
        const button = [...document.querySelectorAll("button")].find(
          (node) => node.textContent?.trim() === label,
        );
        assert.ok(button, `Missing button: ${label}`);
        await act(async () => button.click());
      },
    });
  } finally {
    await act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}
