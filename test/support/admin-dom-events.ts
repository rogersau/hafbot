import assert from "node:assert/strict";

/** Change a form control through the DOM, bypassing React's instance value setter. */
export function changeValue(element: Element | HTMLSelectElement, value: string) {
  const view = element.ownerDocument.defaultView;
  assert.ok(view);
  const prototype =
    element instanceof view.HTMLInputElement
      ? view.HTMLInputElement.prototype
      : element instanceof view.HTMLTextAreaElement
        ? view.HTMLTextAreaElement.prototype
        : element instanceof view.HTMLSelectElement
          ? view.HTMLSelectElement.prototype
          : null;
  assert.ok(prototype, "Expected an input, textarea, or select");
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  assert.ok(setter);
  setter.call(element, value);
  element.dispatchEvent(
    new view.Event(element instanceof view.HTMLSelectElement ? "change" : "input", {
      bubbles: true,
    }),
  );
}
