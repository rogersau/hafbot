import assert from "node:assert/strict";
import test from "node:test";
import { renderToString } from "react-dom/server";

import { createLazyAdminPage, setAdminPageTestLoader } from "../src/admin/routes/lazy-page";

test("lazy Admin pages show accessible feedback while their module is delayed", () => {
  setAdminPageTestLoader(undefined);
  const delayedModule = new Promise<Record<string, unknown>>(() => {});
  const DelayedPage = createLazyAdminPage(() => delayedModule, "DelayedPage");

  const html = renderToString(<DelayedPage />);

  assert.match(html, /role="status"/);
  assert.match(html, /aria-label="Loading page"/);
  assert.match(html, /Loading page\.\.\./);
});

test("lazy Admin pages expose a cached preload for route intent", async () => {
  let loads = 0;
  const Page = createLazyAdminPage(async () => {
    loads += 1;
    return { DelayedPage: () => null };
  }, "DelayedPage");

  await Promise.all([Page.preload(), Page.preload()]);

  assert.equal(loads, 1);
});
