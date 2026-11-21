const { basename } = require("node:path");

const testsUsingBrowserRouter = new Set([
  "admin-auto-save-toggle.test.js",
  "admin-billing-page.test.js",
  "admin-commerce-page.test.js",
  "admin-config-load-failure.test.js",
  "admin-guide-link.test.js",
  "admin-modal-focus-ui.test.js",
  "admin-route-loaders.test.js",
  "admin-settings-drafts-ui.test.js",
  "admin-shell-nav.test.js",
  "admin-tabs-ui.test.js",
]);
if (testsUsingBrowserRouter.has(basename(process.argv[1] ?? ""))) {
  process.env.NODE_ENV = "test";
  globalThis.scrollTo ??= () => {};
}

// DOM constructors follow each test's active JSDOM window.
for (const name of ["HTMLFormElement", "HTMLInputElement", "HTMLSelectElement"]) {
  if (name in globalThis) continue;
  Object.defineProperty(globalThis, name, {
    configurable: true,
    get() {
      return globalThis.window?.[name];
    },
  });
}
