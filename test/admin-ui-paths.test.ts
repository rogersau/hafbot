/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import {
  buildAdminGuildDirectoryApiPath,
  buildAdminOverviewApiPath,
  buildAdminDashboardHref,
} from "../src/admin/App";
import { buildGuildAdminRoleApiPath } from "../src/admin/components/guild-admin-role-card";
import {
  ADMIN_GUILD_DASHBOARD_PATHS,
  isAdminDashboardPath,
  normalizeAdminDashboardPath,
} from "../src/admin/dashboard-routes";
import {
  buildCommerceTabHref,
  getAdminRouteState,
  getCommerceTabFromSearch,
} from "../src/admin/lib/admin-route-state";

test("trailing slash on admin root is normalized to admin dashboard", () => {
  assert.equal(isAdminDashboardPath("/admin/"), true);
  assert.equal(normalizeAdminDashboardPath("/admin/"), "/admin/");
});

test("admin overview and guild directory refresh paths bypass cached Discord lookups", () => {
  assert.equal(buildAdminOverviewApiPath(false), "/admin/api/overview");
  assert.equal(buildAdminOverviewApiPath(true), "/admin/api/overview?refresh=1");
  assert.equal(
    buildAdminOverviewApiPath(true, "workspace-1"),
    "/admin/api/overview?workspaceId=workspace-1&refresh=1",
  );
  assert.equal(buildAdminGuildDirectoryApiPath(false), "/admin/api/guilds");
  assert.equal(buildAdminGuildDirectoryApiPath(true), "/admin/api/guilds?refresh=1");
  assert.equal(
    buildAdminGuildDirectoryApiPath(true, "workspace-1"),
    "/admin/api/guilds?workspaceId=workspace-1&refresh=1",
  );
});

test("guild admin role path preserves workspace and guild ids", () => {
  assert.equal(
    buildGuildAdminRoleApiPath("guild 1", "workspace-1"),
    "/admin/api/guild-rbac/admin-role?guildId=guild+1&workspaceId=workspace-1",
  );
});

test("admin guild overview and guild-scoped feature routes are dashboard routes", () => {
  assert.equal(isAdminDashboardPath("/admin/guild-1"), true);
  assert.equal(normalizeAdminDashboardPath("/admin/guild-1"), "/admin/guild-1");
  assert.equal(isAdminDashboardPath("/admin/guild-1/tickets"), true);
  assert.equal(normalizeAdminDashboardPath("/admin/guild-1/tickets"), "/admin/guild-1/tickets");
  assert.equal(isAdminDashboardPath("/admin/guild-1/player-link"), true);
  assert.equal(isAdminDashboardPath("/admin/guild-1/clans"), true);
  assert.equal(
    normalizeAdminDashboardPath("/admin/guild-1/player-link"),
    "/admin/guild-1/player-link",
  );
  assert.equal(isAdminDashboardPath("/admin/guild-1/troubleshooting"), true);
  assert.equal(
    normalizeAdminDashboardPath("/admin/guild-1/troubleshooting"),
    "/admin/guild-1/troubleshooting",
  );
});

test("reserved admin paths are not treated as guild dashboard routes", () => {
  assert.equal(isAdminDashboardPath("/admin/login"), false);
  assert.equal(isAdminDashboardPath("/admin/logout"), false);
  assert.equal(isAdminDashboardPath("/admin/api/tickets"), false);
  assert.equal(isAdminDashboardPath("/admin/assets/admin.js"), false);
  assert.equal(normalizeAdminDashboardPath("/admin/login"), "/admin");
});

test("admin billing route is a dashboard route", () => {
  assert.equal(isAdminDashboardPath("/admin/billing"), true);
  assert.equal(normalizeAdminDashboardPath("/admin/billing"), "/admin/billing");
});

test("dashboard href preserves workspace and guild ids", () => {
  assert.equal(
    buildAdminDashboardHref("/admin/blocklist", "workspace-1", "guild-1"),
    "/admin/guild-1/blocklist?workspaceId=workspace-1",
  );
  assert.equal(
    buildAdminDashboardHref("/admin/audit-log", "workspace-1", "guild-1"),
    "/admin/guild-1/audit-log?workspaceId=workspace-1",
  );
  assert.equal(
    buildAdminDashboardHref("/admin/image-rules", "workspace-1", "guild-1"),
    "/admin/guild-1/image-rules?workspaceId=workspace-1",
  );
  assert.equal(buildAdminDashboardHref("/admin/guild-1", "", "guild-2"), "/admin/guild-2");
  assert.equal(
    buildAdminDashboardHref("/admin/tickets", "workspace-1", ""),
    "/admin?workspaceId=workspace-1",
  );
});

test("every guild-scoped dashboard route builds a guild-scoped href", () => {
  for (const path of ADMIN_GUILD_DASHBOARD_PATHS) {
    const section = path.slice("/admin/".length);
    assert.equal(
      buildAdminDashboardHref(path, "workspace-1", "guild-1"),
      `/admin/guild-1/${section}?workspaceId=workspace-1`,
    );
    assert.equal(isAdminDashboardPath(`/admin/guild-1/${section}`), true);
  }
});

test("admin route state selects the Player Link platform from the query string", () => {
  assert.equal(
    getAdminRouteState({
      pathname: "/admin/guild-1/player-link",
      search: "?platform=xbox",
    }).playerLinkPlatform,
    "xbox",
  );
  assert.equal(
    getAdminRouteState({
      pathname: "/admin/guild-1/player-link",
      search: "",
    }).playerLinkPlatform,
    "steam",
  );
});

test("commerce route state selects a supported tab and defaults to offerings", () => {
  assert.equal(getCommerceTabFromSearch("?tab=support"), "support");
  assert.equal(getCommerceTabFromSearch("?tab=unknown"), "offerings");
  assert.equal(
    getAdminRouteState({ pathname: "/admin/guild-1/commerce", search: "" }).commerceTab,
    "offerings",
  );
});

test("buildCommerceTabHref preserves existing route search", () => {
  assert.equal(
    buildCommerceTabHref("/admin/guild-1/commerce?workspaceId=workspace-1#support", "support"),
    "/admin/guild-1/commerce?workspaceId=workspace-1&tab=support",
  );
});
