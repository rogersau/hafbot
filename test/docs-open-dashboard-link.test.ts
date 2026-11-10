/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("docs navigation exposes the Admin guide and the live dashboard", async () => {
  const config = await readFile("docs-site/.vitepress/config.mts", "utf8");

  const guideIndex = config.indexOf('{ text: "Admin Dashboard", link: "/admin-dashboard" }');
  const dashboardIndex = config.indexOf(
    '{ text: "Open Dashboard", link: "https://hafbot.xyz/admin" }',
  );

  assert.ok(guideIndex >= 0, "Admin Dashboard guide link is missing");
  assert.ok(dashboardIndex > guideIndex, "Open Dashboard should follow the Admin guide link");
});
