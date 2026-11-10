/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import { isTicketsTabOnlyNavigation } from "../src/admin/components/admin-tickets-page";

test("isTicketsTabOnlyNavigation allows ticket tab and wizard search-param changes", () => {
  assert.equal(
    isTicketsTabOnlyNavigation({
      current: { pathname: "/admin/guild-1/tickets", searchStr: "?tab=panel" },
      next: { pathname: "/admin/guild-1/tickets", searchStr: "?tab=types" },
    }),
    true,
  );

  assert.equal(
    isTicketsTabOnlyNavigation({
      current: { pathname: "/admin/guild-1/tickets", searchStr: "?tab=panel&wizard=1" },
      next: { pathname: "/admin/guild-1/tickets", searchStr: "?tab=panel" },
    }),
    true,
  );
});

test("isTicketsTabOnlyNavigation blocks page and panel selection changes", () => {
  assert.equal(
    isTicketsTabOnlyNavigation({
      current: { pathname: "/admin/guild-1/tickets", searchStr: "?tab=panel" },
      next: { pathname: "/admin/guild-1/blocklist", searchStr: "?tab=blocklist" },
    }),
    false,
  );

  assert.equal(
    isTicketsTabOnlyNavigation({
      current: { pathname: "/admin/guild-1/tickets", searchStr: "?tab=panel&panelId=main" },
      next: { pathname: "/admin/guild-1/tickets", searchStr: "?tab=panel&panelId=secondary" },
    }),
    false,
  );
});
