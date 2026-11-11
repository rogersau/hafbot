import { adminErrorResponse } from "./support/admin-error-response";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createMemoryHistory, createRouter, RouterProvider } from "@tanstack/react-router";
import { renderToString } from "react-dom/server";
import { JSDOM } from "jsdom";

import "./support/admin-page-test-loader";

import App, {
  combineDashboardErrors,
  getDiscordSignInCallbackUrl,
  shouldEnableGuildDirectory,
} from "../src/admin/App";
import * as AdminAppModule from "../src/admin/App";
import { getAdminLoginLocation } from "../src/runtime/admin-shell";
import { AdminBottomActionBar } from "../src/admin/components/admin-bottom-action-bar";
import { AdminGuildSettingsPage } from "../src/admin/components/admin-guild-settings-page";
import {
  getAdminWorkspaceCloseTarget,
  getAdminWorkspaceRouteId,
  upsertAdminWorkspaceTab,
} from "../src/admin/components/admin-workspace-tabs";
import {
  AdminBotDefensePage,
  normalizeBotDefenseConfigSnapshot,
  validateBotDefenseConfig,
} from "../src/admin/components/admin-bot-defense-page";

import {
  areTicketPanelConfigsEqual,
  ClosedTicketsSection,
  validateTicketPanelBeforeSubmit,
} from "../src/admin/components/admin-tickets-page";
import { TicketPanelEditor } from "../src/admin/components/ticket-panel-editor";
import { readJsonOrThrow } from "../src/admin/lib/api";
import {
  buildReactionRulesTabHref,
  getAdminRouteState,
  getDefaultAdminRedirectTarget,
} from "../src/admin/lib/admin-route-state";
import { renderTimedRoleDmPreview } from "../src/admin/components/admin-timed-roles-page";
import type { AdminPageMetadata, AdminRouterContext } from "../src/admin/routes/context";
import { AdminRouteContextProvider } from "../src/admin/routes/page-context";
import { routeTree } from "../src/admin/routes/route-tree";
import type { EntitlementInfo } from "../src/admin/hooks/use-entitlement";
import type {
  LoadedAdminRouteData,
  GuildOverviewLoaderData,
} from "../src/admin/lib/admin-route-loaders";
import type {
  AdminGuildDirectoryEntry,
  AdminGuildOverviewCard,
  AdminPermissionDiagnosticsResponse,
} from "../src/runtime/admin-types";
import type { TicketPanelConfig, TicketQuestion } from "../src/types";

const guildDirectory: AdminGuildDirectoryEntry[] = [
  { guildId: "guild-1", name: "Alpha", label: "Alpha", icon: null },
  { guildId: "guild-2", name: "Bravo", label: "Bravo", icon: null },
];

test("getDiscordSignInCallbackUrl: empty string returns /admin", () => {
  assert.equal(getDiscordSignInCallbackUrl(""), "/admin");
});

test("getDiscordSignInCallbackUrl: no next param returns /admin", () => {
  assert.equal(getDiscordSignInCallbackUrl("?other=value"), "/admin");
});

test("getDiscordSignInCallbackUrl: customer dashboard paths keep supported destinations", () => {
  assert.equal(getDiscordSignInCallbackUrl("?next=%2Fadmin%2Fgateway"), "/admin");
  assert.equal(
    getDiscordSignInCallbackUrl("?next=%2Fadmin%2Fguild-1%2Ftickets"),
    "/admin/guild-1/tickets",
  );
  assert.equal(getDiscordSignInCallbackUrl("?next=%2Fadmin%2Fbilling"), "/admin/billing");
  assert.equal(
    getDiscordSignInCallbackUrl(
      "?next=%2Fadmin%2Fbilling%3Fplan%3Dpremium_plus%26frequency%3Dyearly",
    ),
    "/admin/billing?plan=premium_plus&frequency=yearly",
  );
  assert.equal(getDiscordSignInCallbackUrl("?next=%2Fadmin"), "/admin");
});

test("getDiscordSignInCallbackUrl: external URL next returns /admin", () => {
  assert.equal(getDiscordSignInCallbackUrl("?next=https%3A%2F%2Fevil.com"), "/admin");
});

test("getDiscordSignInCallbackUrl: non-dashboard path next returns /admin", () => {
  assert.equal(getDiscordSignInCallbackUrl("?next=%2Fevil"), "/admin");
});

test("unauthenticated admin App renders the Discord sign-in prompt", () => {
  const html = renderToString(<App />);
  assert.match(html, /Continue with Discord/);
});

test("Guild directory waits for automatic workspace selection", () => {
  assert.equal(shouldEnableGuildDirectory(true, "", true, 0), false);
  assert.equal(shouldEnableGuildDirectory(true, "", false, 1), false);
  assert.equal(shouldEnableGuildDirectory(true, "workspace-1", true, 1), true);
  assert.equal(shouldEnableGuildDirectory(true, "", false, 0), true);
  assert.equal(shouldEnableGuildDirectory(false, "workspace-1", false, 1), false);
});

test("checkout-aware sign in explains that the selected plan will continue after Discord", () => {
  const html = renderToString(
    <App
      initialPath="/admin/login"
      initialSearch="?next=%2Fadmin%2Fbilling%3Fplan%3Dpremium_plus%26frequency%3Dyearly"
    />,
  );
  assert.match(html, /Sign in to continue to checkout/);
  assert.match(html, /Premium Plus yearly/);
  assert.match(html, /Your selection is saved/);
  assert.match(html, /creates your account automatically/);
});

test("admin login redirect preserves billing product selection", () => {
  assert.equal(
    getAdminLoginLocation("/admin/billing?plan=premium&frequency=yearly"),
    "/admin/login?next=%2Fadmin%2Fbilling%3Fplan%3Dpremium%26frequency%3Dyearly",
  );
});

test("authenticated admin dashboard uses the header and drawer shell", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/tickets" />);

  assert.match(html, /<header[^>]*aria-label="Tickets controls"/);
  assert.match(html, /lg:static lg:z-auto lg:w-\[15\.75rem\]/);
  assert.match(html, /-translate-x-full lg:translate-x-0/);
  assert.match(html, /Current guild/);
});

test("Guild Settings renders guild controls without requiring a workspace", () => {
  const html = renderToString(
    <App initialAuthenticated initialPath="/admin/guild-1/guild-settings" />,
  );

  assert.match(html, /HAF admin role/);
  assert.doesNotMatch(html, /Select a workspace to manage guild settings\./);
});

test("Ops Workshop shell opens a deep-linked feature beside pinned Overview", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/tickets" />);
  const workspaceTabs =
    html.match(/aria-label="Open admin pages"[\s\S]*?<\/div><\/div>/)?.[0] ?? "";

  assert.match(
    workspaceTabs,
    /role="tab"[^>]*aria-selected="false"[^>]*>[^<]*<span[^>]*><\/span><span>Overview<\/span>/,
  );
  assert.match(workspaceTabs, /aria-label="Pinned tab"/);
  assert.match(workspaceTabs, /role="tab"[^>]*aria-selected="true"[^>]*[\s\S]*Tickets/);
  assert.match(workspaceTabs, /aria-label="Close Tickets"/);
  assert.match(html, /aria-label="Admin status"/);
  assert.match(html, /aria-labelledby="admin-workspace-tab-tickets"/);
});

test("workspace route identity ignores page-local query state", () => {
  assert.equal(getAdminWorkspaceRouteId("/admin/guild-1", "guild-1"), "overview");
  assert.equal(getAdminWorkspaceRouteId("/admin/guild-1/tickets", "guild-1"), "tickets");
  assert.equal(getAdminWorkspaceRouteId("/admin/guild-1/player-link", "guild-1"), "player-link");
  assert.equal(getAdminWorkspaceRouteId("/admin/profile", "guild-1"), "profile");
});

test("workspace tabs reuse route identities and close to the most recent open tab", () => {
  const overview = { id: "overview", label: "Overview", href: "/admin/guild-1", pinned: true };
  const tickets = {
    id: "tickets",
    label: "Tickets",
    href: "/admin/guild-1/tickets?tab=panel",
    pinned: false,
  };
  const updatedTickets = { ...tickets, href: "/admin/guild-1/tickets?tab=rules" };
  const events = {
    id: "events",
    label: "Events",
    href: "/admin/guild-1/events",
    pinned: false,
  };
  const tabs = upsertAdminWorkspaceTab(
    upsertAdminWorkspaceTab([overview, tickets], updatedTickets),
    events,
  );

  assert.equal(tabs.length, 3);
  assert.equal(tabs[1]?.href, updatedTickets.href);
  assert.equal(
    getAdminWorkspaceCloseTarget(tabs, ["overview", "tickets", "events"], "events")?.id,
    "tickets",
  );
  assert.equal(
    getAdminWorkspaceCloseTarget([overview, events], ["events"], "events")?.id,
    "overview",
  );
});

test("account menu trigger keeps an accessible name when the visible username is hidden", () => {
  const html = renderToString(
    <App initialAuthenticated initialPath="/admin/guild-1/tickets" initialUserName="Alex Morgan" />,
  );

  assert.match(html, /aria-label="Open account menu for Alex Morgan"/);
  assert.match(html, /aria-haspopup="menu"/);
  assert.match(html, /aria-expanded="false"/);
});

test("admin redesign renders grouped sidebar and Tickets topbar without save actions", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/tickets" />);
  const sidebarNavigation = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

  assert.match(sidebarNavigation, />Overview</);
  assert.match(sidebarNavigation, />Moderation</);
  assert.match(sidebarNavigation, />Community Management</);
  assert.match(sidebarNavigation, />Access Control</);
  assert.match(sidebarNavigation, />Integrations</);
  assert.match(sidebarNavigation, />Configuration</);
  assert.match(sidebarNavigation, /translate-y-px[^>]*>Tickets</);
  assert.match(html, /Configure how your guild handles support tickets\./);
  assert.doesNotMatch(html, /<header[\s\S]*>Save Changes[\s\S]*<\/header>/);
  assert.doesNotMatch(html, /<header[\s\S]*>Publish Panel[\s\S]*<\/header>/);
  assert.doesNotMatch(html, /Setup Progress/);
  assert.doesNotMatch(html, /Validation/);
  assert.doesNotMatch(html, /Quick Tips/);
});

test("Tickets page renders a tab bar with Panel, Types, Rules, and Closed Tickets", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/tickets" />);

  assert.match(html, />Panel history</);
  assert.match(html, /role="tablist"/);
  assert.match(html, />Panel</);
  assert.match(html, />Types</);
  assert.match(html, />Rules</);
  assert.match(html, />Closed Tickets</);
  assert.match(html, /aria-selected="true"[^>]*>Panel</);
});

test("Tickets page passes route-context entitlement to the page component", () => {
  const entitlement: EntitlementInfo = {
    tier: "free",
    limits: {
      blocklistMaxEmojis: 50,
      reactionLimitsEnabled: false,
      ticketsMaxPanels: 1,
      ticketsMaxTypesPerPanel: 1,
      platformLinkMaxLinks: null,
      managedMessagesMax: 3,
      evidenceVaultMaxRecords: 30,
      r2MaxBytes: 0,
      paidFeatures: false,
    },
    supportInvite: null,
    r2Usage: { usedBytes: 0, reservedBytes: 0, maxBytes: 0, lastReconciledAtMs: null },
  };
  const context = createTestAdminRouterContext({
    currentPath: "/admin/guild-1/tickets",
    selectedGuildId: "guild-1",
    pathGuildId: "guild-1",
    guildDirectory,
    entitlement,
  });
  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    history: createMemoryHistory({ initialEntries: ["/admin/guild-1/tickets"] }),
    context,
  });
  router.stores.setMatches(
    router.matchRoutes(router.state.location).map((match) => ({
      ...match,
      status: "success" as const,
    })),
  );

  const html = renderToString(
    <AdminRouteContextProvider value={context}>
      <RouterProvider router={router} context={context} />
    </AdminRouteContextProvider>,
  );

  assert.match(html, /Configure how your guild handles support tickets\./);
  assert.doesNotMatch(html, /Tickets requires a paid plan\./);
});

test("Player Link falls back to Steam when PlayStation is disabled", () => {
  const context = createTestAdminRouterContext({
    currentPath: "/admin/guild-1/player-link",
    selectedGuildId: "guild-1",
    pathGuildId: "guild-1",
    guildDirectory,
    playstationLinkEnabled: false,
  });
  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    history: createMemoryHistory({
      initialEntries: ["/admin/guild-1/player-link?platform=playstation"],
    }),
    context,
  });
  router.stores.setMatches(
    router.matchRoutes(router.state.location).map((match) => ({
      ...match,
      status: "success" as const,
    })),
  );

  const html = renderToString(
    <AdminRouteContextProvider value={context}>
      <RouterProvider router={router} context={context} />
    </AdminRouteContextProvider>,
  );

  assert.match(html, /Link your Steam account/);
  assert.doesNotMatch(html, /Link your PlayStation account/);
});

test("admin bottom action bar renders page actions at the bottom", () => {
  const html = renderToString(
    <AdminBottomActionBar
      actions={[
        {
          label: "Publish panel",
          loadingLabel: "Publishing...",
          loading: true,
          disabled: true,
          variant: "secondary",
          onClick: () => {},
        },
        {
          label: "Save changes",
          disabled: true,
          variant: "accent",
          onClick: () => {},
        },
      ]}
    />,
  );

  assert.doesNotMatch(html, /sticky bottom-0/);
  assert.match(html, /relative z-20/);
  assert.match(html, /shrink-0/);
  assert.doesNotMatch(html, /-mb-/);
  assert.doesNotMatch(html, /-mx-/);
  assert.match(html, /bg-background/);
  assert.doesNotMatch(html, /bg-background\/95/);
  assert.match(html, />Publishing\.\.\.</);
  assert.match(html, />Save changes</);
  assert.match(html, /disabled=""/);
});

test("Bot Defense uses the operations workspace layout", () => {
  const html = renderToString(
    <App initialAuthenticated initialPath="/admin/guild-1/bot-defense" />,
  );

  assert.match(html, /admin-feature-page admin-page-settings admin-bot-defense-page/);
  assert.match(html, /admin-bot-defense-status/);
  assert.match(html, /admin-bot-defense-layout/);
  assert.match(html, /admin-bot-defense-detection/);
  assert.match(html, /admin-bot-defense-review/);
  assert.match(html, /admin-bottom-action-bar/);
  assert.match(html, /admin-bottom-action-bar-host/);
});

test("Free Bot Defense keeps Honeypot available and disables Rate Detector", () => {
  const html = renderToString(
    <AdminBotDefensePage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      entitlement={{
        tier: "free",
        limits: {
          blocklistMaxEmojis: 10,
          reactionLimitsEnabled: true,
          ticketsMaxPanels: 1,
          ticketsMaxTypesPerPanel: 1,
          platformLinkMaxLinks: 100,
          managedMessagesMax: 3,
          evidenceVaultMaxRecords: 30,
          r2MaxBytes: 0,
          paidFeatures: false,
        },
        supportInvite: null,
        r2Usage: { usedBytes: 0, reservedBytes: 0, maxBytes: 0, lastReconciledAtMs: null },
      }}
    />,
  );

  assert.match(
    html,
    /(?:aria-label="Enable Rate Detector"[^>]*disabled=""|disabled=""[^>]*aria-label="Enable Rate Detector")/,
  );
  assert.doesNotMatch(
    html,
    /(?:aria-label="Enable Honeypot Detector"[^>]*disabled=""|disabled=""[^>]*aria-label="Enable Honeypot Detector")/,
  );
});

test("every guild admin route uses an explicit operations page family", () => {
  const routesByFamily = {
    "admin-page-settings": [
      "blocklist",
      "image-rules",
      "bot-defense",
      "member-verification",
      "guild-settings",
      "timed-roles",
      "player-link",
    ],
    "admin-page-workflow": ["tickets", "webhooks", "lfg", "marketplace", "playercount", "events"],
    "admin-page-data": ["evidence-vault", "ban-cases", "audit-log"],
    "admin-page-system": ["troubleshooting"],
  } as const;

  for (const [family, routes] of Object.entries(routesByFamily)) {
    for (const route of routes) {
      const html = renderToString(
        <App initialAuthenticated initialPath={`/admin/guild-1/${route}`} />,
      );
      assert.match(html, new RegExp(`admin-feature-page ${family}`), `${route} uses ${family}`);
    }
  }
});

test("Bot Defense validates enabled rate detector thresholds", () => {
  const config = normalizeBotDefenseConfigSnapshot({
    rateEnabled: true,
    rateChannelThreshold: 1,
    rateWindowSeconds: 0,
  });

  assert.deepEqual(validateBotDefenseConfig(config), {
    honeypotChannels: null,
    rateThreshold: "Rate threshold must be at least 2 matching channels.",
    rateWindow: "Time window must be at least 1 second.",
  });
});

test("Bot Defense rejects an unusually broad honeypot scope", () => {
  const config = normalizeBotDefenseConfigSnapshot({
    honeypotChannelIds: Array.from({ length: 11 }, (_, index) => `channel-${index + 1}`),
  });

  assert.equal(
    validateBotDefenseConfig(config).honeypotChannels,
    "Choose no more than 10 honeypot channels.",
  );
});

test("Bot Defense clearly explains automatic honeypot deletion", () => {
  const html = renderToString(
    <AdminBotDefensePage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      entitlement={null}
      initialData={{
        guildId: "guild-1",
        entitlement: null,
        config: {
          guildId: "guild-1",
          honeypotEnabled: true,
          honeypotWarnUser: false,
          honeypotDeleteMessage: true,
          rateEnabled: false,
          rateWarnUser: false,
          rateDeleteMessage: false,
          honeypotChannelIds: ["channel-1", "channel-2"],
          rateChannelThreshold: 5,
          rateWindowSeconds: 60,
          excludedRoleIds: [],
          modRoleIds: [],
          modQueueChannelId: null,
          pingOnQueuePost: false,
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      }}
    />,
  );

  assert.match(html, /Every message posted in a selected channel triggers Bot Defense/);
  assert.match(html, /Automatically delete every triggering message/);
  assert.match(html, /Automatic message deletion is enabled/);
  assert.match(html, /2 selected honeypot channels/);
});

test("admin shell resets topbar metadata when navigating away from Tickets", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1" />);

  assert.doesNotMatch(html, /Configure how your guild handles support tickets\./);
  assert.doesNotMatch(html, />Save Changes</);
  assert.doesNotMatch(html, />Publish Panel</);
  assert.match(html, /No configuration issues need your attention\./);
});

test("admin shell hides the nonfunctional Search and Notifications affordances", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/tickets" />);

  assert.doesNotMatch(html, /Search\.\.\./);
  assert.doesNotMatch(html, /aria-label="Notifications"/);
});

test("admin shell shows page loading feedback while a route transition is pending", () => {
  const routerContext = createTestAdminRouterContext({
    currentPath: "/admin/guild-1",
    selectedGuildId: "guild-1",
    pathGuildId: "guild-1",
    guildDirectory,
    isRoutePending: true,
  });
  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    history: createMemoryHistory({ initialEntries: ["/admin/guild-1"] }),
    context: routerContext,
  });

  router.stores.setMatches(
    router
      .matchRoutes(router.state.location)
      .map((match) =>
        match.status === "pending" ? { ...match, status: "success" as const } : match,
      ),
  );

  const html = renderToString(
    <AdminRouteContextProvider value={routerContext}>
      <RouterProvider router={router} context={routerContext} />
    </AdminRouteContextProvider>,
  );

  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-label="Loading page"/);
  assert.match(html, /role="status"[^>]*>Loading page/);
  assert.match(html, /Overview/i);
});

test("admin shell renders the signed-in Discord profile in the account menu trigger", () => {
  const html = renderToString(
    <App
      initialAuthenticated
      initialPath="/admin/guild-1/tickets"
      initialUserName="Jane Discord"
      initialUserImage="https://cdn.discordapp.com/avatars/user/avatar.png"
    />,
  );

  assert.match(html, />Jane Discord</);
  assert.match(
    html,
    /<img[^>]+src="https:\/\/cdn\.discordapp\.com\/avatars\/user\/avatar\.png"[^>]+alt="Jane Discord"/,
  );
  assert.doesNotMatch(html, /Admin User/);
});

test("customer Billing lives in the account menu instead of the sidebar", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/tickets" />);

  assert.doesNotMatch(html, /<nav[\s\S]*Billing[\s\S]*<\/nav>/);
  assert.match(
    html,
    /role="menuitem"[^>]*href="\/admin\/billing\?guildId=guild_guild-1"[^>]*>[\s\S]*Billing/,
  );
});

test("account menu exposes a Profile link alongside Billing", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/tickets" />);

  assert.match(html, /role="menuitem"[^>]*href="\/admin\/profile"[^>]*>[\s\S]*Profile/);
});

test("the authenticated admin shell renders the shared logo asset", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/tickets" />);

  assert.match(html, /<img[^>]+src="\/logo\.png"[^>]+alt=""[^>]+aria-hidden="true"/);
});

test("billing keeps the selected guild visible while the guild directory is unavailable", () => {
  const html = renderToString(
    <App initialAuthenticated initialPath="/admin/billing" initialSearch="?guildId=guild-1" />,
  );

  assert.match(html, /data-current-path="\/admin\/billing"/);
  assert.match(html, />guild-1</);
  assert.doesNotMatch(html, />select a guild</);
});

test("customer sidebar keeps troubleshooting in a settings submenu", () => {
  const html = renderToString(
    <App initialAuthenticated initialPath="/admin/guild-1/troubleshooting" />,
  );

  assert.match(html, />Configuration</);
  assert.match(html, /aria-current="page"[^>]*>[\s\S]*Troubleshooting/);
});

test("customer sidebar keeps the profile page in the settings submenu", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/profile" />);

  const sidebarNavigation = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

  assert.match(html, />Configuration</);
  assert.match(sidebarNavigation, /href="\/admin\/profile"/);
  assert.match(sidebarNavigation, />Profile</);
  assert.match(sidebarNavigation, /aria-current="page"[^>]*>[\s\S]*Profile/);
});

test("customer sidebar exposes Configuration History and marks it active", () => {
  const html = renderToString(
    <App initialAuthenticated initialPath="/admin/guild-1/tickets" initialSearch="?tab=history" />,
  );
  const sidebarNavigation = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

  assert.match(
    sidebarNavigation,
    /href="\/admin\/guild-1\/tickets\?tab=history"[\s\S]*>Configuration History</,
  );
  assert.match(sidebarNavigation, /aria-current="page"[^>]*>[\s\S]*Configuration History/);
});

test("authenticated admin dashboard renders the profile page at /admin/profile", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/profile" />);

  assert.match(html, /Identity/);
  assert.match(html, /Guilds/);
  assert.match(html, /Appearance/);
  assert.doesNotMatch(html, /Notifications/);
  assert.doesNotMatch(html, /Language/);
});

test("customer sidebar collapses inactive nested groups by default", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1" />);
  const sidebarNavigation = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

  assert.match(sidebarNavigation, />Reaction Rules</);
  assert.match(sidebarNavigation, />Configuration</);
  assert.doesNotMatch(sidebarNavigation, /href="\/admin\/guild-1\/blocklist\?tab=blocklist"/);
  assert.doesNotMatch(sidebarNavigation, /bg-primary\/10 text-primary[^>]*>[\s\S]*Troubleshooting/);
});

test("customer sidebar opens active Reaction Rules tab links", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/blocklist" />);
  const sidebarNavigation = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

  assert.match(sidebarNavigation, />Reaction Rules</);
  assert.match(sidebarNavigation, /aria-expanded="true"[\s\S]*Reaction Rules/);
  assert.match(
    sidebarNavigation,
    /href="\/admin\/guild-1\/blocklist\?tab=blocklist"[\s\S]*>Blocklist</,
  );
  assert.match(sidebarNavigation, /href="\/admin\/guild-1\/blocklist\?tab=limits"[\s\S]*>Limits</);
});

test("customer sidebar groups routes by domain", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1" />);
  const sidebarNavigation = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";
  const labels = [
    "Overview",
    "Dashboard",
    "Moderation",
    "Reaction Rules",
    "Evidence Vault",
    "Community Management",
    "LFG",
    "Marketplace",
    "Tickets",
    "Access Control",
    "Timed Roles",
    "Integrations",
    "Player Link",
    "Webhooks",
    "Player Count",
    "Configuration",
    "Configuration History",
    "Profile",
    "Troubleshooting",
  ];
  const positions = labels.map((label) => sidebarNavigation.indexOf(`>${label}<`));

  assert.ok(
    positions.every((position) => position >= 0),
    "expected all sidebar labels to render",
  );
  assert.deepEqual(
    positions,
    [...positions].sort((left, right) => left - right),
  );
});

test("Reaction Rules tab state comes from router search", () => {
  const html = renderToString(
    <App initialAuthenticated initialPath="/admin/guild-1/blocklist" initialSearch="?tab=limits" />,
  );
  const sidebarNavigation = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

  assert.match(sidebarNavigation, /aria-current="page"[^>]*>[\s\S]*Limits/);
  assert.match(html, /data-reaction-rules-tab="limits"/);
});

test("customer sidebar opens active Player Link platform links", () => {
  const html = renderToString(
    <App
      initialAuthenticated
      initialPath="/admin/guild-1/player-link"
      initialSearch="?platform=xbox"
    />,
  );
  const sidebarNavigation = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

  assert.match(sidebarNavigation, />Player Link</);
  assert.match(sidebarNavigation, /aria-expanded="true"[\s\S]*Player Link/);
  assert.match(
    sidebarNavigation,
    /href="\/admin\/guild-1\/player-link\?platform=steam"[\s\S]*>Steam Link</,
  );
  assert.match(
    sidebarNavigation,
    /href="\/admin\/guild-1\/player-link\?platform=xbox"[\s\S]*>Xbox Link</,
  );
  assert.match(sidebarNavigation, /aria-current="page"[^>]*>[\s\S]*Xbox Link/);
});

test("authenticated admin dashboard renders overview content instead of editor sections", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1" />);

  assert.match(html, /data-current-path="\/admin\/guild-1"/);
  assert.match(html, /Overview/i);
  assert.doesNotMatch(html, /Quick actions/i);
  assert.doesNotMatch(html, /Refresh dashboard/i);
  assert.doesNotMatch(html, /App admin role/i);
  assert.doesNotMatch(html, /Loading billing details/i);
  assert.doesNotMatch(html, /Start gateway/i);
});

test("Guild Settings distinguishes HAF dashboard access from Discord permissions", () => {
  const html = renderToString(
    <AdminGuildSettingsPage
      selectedWorkspaceId="workspace-1"
      selectedGuildId="guild-1"
      initialData={{ adminRoleId: null }}
    />,
  );

  assert.match(html, /HAF admin role/);
  assert.match(
    html,
    /Members with this Discord role can access and configure this guild in the HAF dashboard\. This does not grant additional Discord permissions\./,
  );
  assert.doesNotMatch(html, /App admin role/);
});

test("Overview page renders tier badge and cards from loader data", () => {
  const entitlement: EntitlementInfo = {
    tier: "premium",
    limits: {
      blocklistMaxEmojis: 100,
      reactionLimitsEnabled: true,
      ticketsMaxPanels: 1,
      ticketsMaxTypesPerPanel: 5,
      platformLinkMaxLinks: 1,
      managedMessagesMax: null,
      evidenceVaultMaxRecords: null,
      r2MaxBytes: 100,
      paidFeatures: true,
    },
    supportInvite: null,
    r2Usage: { usedBytes: 0, reservedBytes: 0, maxBytes: 100, lastReconciledAtMs: null },
  };
  const card: AdminGuildOverviewCard = {
    id: "blocklist",
    label: "Reaction Rules",
    path: "/admin/guild-1/blocklist",
    status: "configured",
    detail: null,
    locked: false,
  };
  const loaderData: LoadedAdminRouteData<GuildOverviewLoaderData> = {
    data: {
      entitlement,
      overview: { guildId: "guild-1", tier: "premium", cards: [card] },
    },
    loadedAt: 1,
  };
  const context = createTestAdminRouterContext({
    currentPath: "/admin/guild-1",
    selectedGuildId: "guild-1",
    pathGuildId: "guild-1",
    guildDirectory,
  });
  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    history: createMemoryHistory({ initialEntries: ["/admin/guild-1"] }),
    context,
  });
  router.stores.setMatches(
    router.matchRoutes(router.state.location).map((match) => ({
      ...match,
      loaderData,
      status: "success" as const,
    })),
  );

  const html = renderToString(
    <AdminRouteContextProvider value={context}>
      <RouterProvider router={router} context={context} />
    </AdminRouteContextProvider>,
  );

  assert.match(html, />Premium</);
  assert.match(html, />Reaction Rules</);
});

test("authenticated admin dashboard keeps navigation labels for future workflow pages", () => {
  const html = renderToString(<App initialAuthenticated />);
  const sidebarNavigation = html.match(/<nav[\s\S]*?<\/nav>/)?.[0] ?? "";

  assert.match(html, />Overview</);
  assert.doesNotMatch(sidebarNavigation, /href="\/admin\/billing"/);
  assert.match(html, /Configuration/i);
  assert.match(html, /Reaction Rules/i);
  assert.match(html, /Timed Roles/i);
  assert.match(html, />Tickets</);
  assert.match(html, />Evidence Vault</);
  assert.match(html, />Webhooks</);
  assert.doesNotMatch(html, />Gateway</);
  assert.doesNotMatch(html, />Workspaces</);
});

test("admin route shell reads the live app context for loaded guilds", () => {
  const staleRouterContext = createTestAdminRouterContext({ guildDirectory: null });
  const liveAppContext = createTestAdminRouterContext({ guildDirectory });
  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    history: createMemoryHistory({ initialEntries: ["/admin"] }),
    context: staleRouterContext,
  });

  router.stores.setMatches(router.matchRoutes(router.state.location));

  const html = renderToString(
    <AdminRouteContextProvider value={liveAppContext}>
      <RouterProvider router={router} context={staleRouterContext} />
    </AdminRouteContextProvider>,
  );

  assert.match(html, /select a guild/);
  assert.doesNotMatch(html, /Loading guilds/);
});

test("admin index offers installation and refresh when no servers are available", () => {
  const html = renderAdminIndex(createTestAdminRouterContext({ guildDirectory: [] }));

  assert.match(html, /No servers available/);
  assert.match(html, /href="\/install"/);
  assert.match(html, /Add HAF to a server/);
  assert.match(html, /Refresh servers/);
  assert.doesNotMatch(html, /Everything configured is operating normally/);
  assert.doesNotMatch(html, /data-section="all-features"/);
});

test("admin index keeps server selection and scoped profile recovery in the lazy discovery card", () => {
  const html = renderAdminIndex(createTestAdminRouterContext({ guildDirectory }));

  assert.match(html, /Choose a server/);
  assert.match(html, /Choose a server from Current guild/);
  assert.match(html, /Add HAF to a server/);
  assert.match(html, /href="\/admin\/profile\?workspaceId=workspace-1"/);
  assert.match(html, /Manage hidden servers/);
  assert.doesNotMatch(html, /Everything configured is operating normally/);
});

test("admin index links to the current workspace profile when all servers are hidden", () => {
  const context = createTestAdminRouterContext({
    guildDirectory,
    selectedWorkspaceId: "workspace-1",
  });
  context.userPreferences.hiddenGuildIds = guildDirectory.map((guild) => guild.guildId);
  const html = renderAdminIndex(context);

  assert.match(html, /Your servers are hidden/);
  assert.match(html, /href="\/admin\/profile\?workspaceId=workspace-1"/);
  assert.match(html, /Restore hidden servers/);
  assert.doesNotMatch(html, /Add HAF to a server/);
  assert.doesNotMatch(html, /Everything configured is operating normally/);
});

test("admin index reports directory failures instead of claiming healthy configuration", () => {
  const html = renderAdminIndex(
    createTestAdminRouterContext({ guildLookupError: "Please reconnect your Discord account." }),
  );

  assert.match(html, /Could not load your servers/);
  assert.match(html, /Please reconnect your Discord account/);
  assert.match(html, /Refresh servers/);
  assert.doesNotMatch(html, /Add HAF to a server/);
  assert.doesNotMatch(html, /Everything configured is operating normally/);
});

function renderAdminIndex(context: AdminRouterContext) {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/admin?workspaceId=workspace-1"] }),
    context,
  });
  router.stores.setMatches(router.matchRoutes(router.state.location));
  return renderToString(
    <AdminRouteContextProvider value={context}>
      <RouterProvider router={router} context={context} />
    </AdminRouteContextProvider>,
  );
}

test("authenticated admin dashboard renders the Evidence Vault setup page", () => {
  const html = renderToString(
    <App initialAuthenticated initialPath="/admin/guild-1/evidence-vault" />,
  );

  assert.match(html, /aria-current="page"[^>]*>[\s\S]*?Evidence Vault<\/span><\/a>/);
  assert.match(html, /access-control safeguard/i);
  assert.match(html, /Audit channel/);
  assert.match(html, /The bot needs permission to read, delete, and repost messages/);
  assert.doesNotMatch(html, /Reaction Rules cannot enforce penalties/);
});

test("authenticated admin dashboard renders the blocklist workspace on /admin/guild-1/blocklist", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/blocklist" />);

  assert.match(html, /aria-current="page"[^>]*>[\s\S]*?Reaction Rules<\/span>/);
  assert.match(html, /id="sidebar-guild"/);
  assert.doesNotMatch(html, /No server selected/i);
  assert.doesNotMatch(html, /Permission check/i);
  assert.doesNotMatch(html, /live Discord permission check/i);
  assert.doesNotMatch(html, /id="bl-guild-query"/);
  assert.doesNotMatch(html, /Add timed role/i);
  assert.doesNotMatch(html, /Load ticket panel/i);
});

test("Reaction Rules wizard query opens the Blocklist setup flow", () => {
  const html = renderToString(
    <App
      initialAuthenticated
      initialPath="/admin/guild-1/blocklist"
      initialSearch="?tab=blocklist&wizard=1"
    />,
  );

  assert.match(html, /Blocklist setup wizard/);
  assert.match(html, /Choose a blocked emoji/);
  assert.doesNotMatch(html, /Max reactions per message/);
});

test("authenticated admin dashboard renders reaction rules tabs and limits form", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/blocklist" />);

  assert.match(html, /Reaction Rules/);
  assert.match(html, /Blocklist/);
  assert.match(html, /Limits/);
  assert.match(
    html,
    /Select an emoji to add it to the Blocklist\. HAF Bot removes that reaction automatically\./,
  );
  assert.doesNotMatch(
    html,
    /Selecting an emoji immediately applies the chosen add or remove action/,
  );
  assert.doesNotMatch(html, />Remove</);
  assert.match(html, /Max reactions per message/);
  assert.match(html, /Breach DM text/);
});

test("authenticated admin dashboard renders the timed roles workspace on /admin/guild-1/timed-roles", () => {
  const html = renderToString(
    <App initialAuthenticated initialPath="/admin/guild-1/timed-roles" />,
  );

  assert.match(html, /aria-current="page"[^>]*>[\s\S]*?Timed Roles<\/span><\/a>/);
  assert.match(html, /id="sidebar-guild"/);
  assert.doesNotMatch(html, /No server selected/i);
  assert.doesNotMatch(html, /Permission check/i);
  assert.doesNotMatch(html, /live Discord permission check/i);
  assert.doesNotMatch(html, /highest role/i);
  assert.doesNotMatch(html, /id="tr-guild-query"/);
  assert.doesNotMatch(html, /Load blocklist/i);
  assert.doesNotMatch(html, /Load ticket panel/i);
});

test("authenticated admin dashboard renders the troubleshooting workspace on /admin/guild-1/troubleshooting", () => {
  const html = renderToString(
    <App initialAuthenticated initialPath="/admin/guild-1/troubleshooting" />,
  );

  assert.match(html, /aria-current="page"[^>]*>[\s\S]*?Troubleshooting<\/span><\/a>/);
  assert.doesNotMatch(html, /No server selected/i);
  assert.match(html, /Discord diagnostics/i);
  assert.doesNotMatch(html, /Load blocklist/i);
  assert.doesNotMatch(html, /Add timed role/i);
});

test("Troubleshooting page renders diagnostics from raw loader data", () => {
  const diagnostics: AdminPermissionDiagnosticsResponse = {
    guildId: "guild-1",
    checksByFeature: {
      blocklist: [],
      "timed-roles": [],
      tickets: [],
      marketplace: [],
      lfg: [],
      "player-count": [],
      "evidence-vault": [],
      "mention-protection": [],
    },
  };
  const loaderData: LoadedAdminRouteData<AdminPermissionDiagnosticsResponse> = {
    data: diagnostics,
    loadedAt: 1,
  };
  const context = createTestAdminRouterContext({
    currentPath: "/admin/guild-1/troubleshooting",
    selectedGuildId: "guild-1",
    pathGuildId: "guild-1",
    guildDirectory,
  });
  const router = createRouter({
    routeTree,
    defaultPreload: "intent",
    history: createMemoryHistory({
      initialEntries: ["/admin/guild-1/troubleshooting"],
    }),
    context,
  });
  router.stores.setMatches(
    router.matchRoutes(router.state.location).map((match) => ({
      ...match,
      loaderData,
      status: "success" as const,
    })),
  );

  const html = renderToString(
    <AdminRouteContextProvider value={context}>
      <RouterProvider router={router} context={context} />
    </AdminRouteContextProvider>,
  );

  assert.match(html, /Discord diagnostics/i);
  assert.match(html, /Not configured/);
});

test("authenticated admin dashboard renders the billing page on /admin/billing", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/billing" />);

  assert.match(html, /<h1>Billing<\/h1>/);
  assert.doesNotMatch(html, /No server selected/i);
});

test("authenticated admin dashboard renders the tickets workspace on /admin/guild-1/tickets", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/tickets" />);

  assert.match(html, /aria-current="page"[^>]*>[\s\S]*?Tickets<\/span><\/a>/);
  assert.match(html, /id="sidebar-guild"/);
  assert.doesNotMatch(html, /No server selected/i);
  assert.doesNotMatch(html, /Permission check/i);
  assert.doesNotMatch(html, /live Discord permission check/i);
  assert.doesNotMatch(html, /channel access/i);
  assert.doesNotMatch(html, /support roles/i);
  assert.doesNotMatch(html, /id="tp-guild-query"/);
  assert.doesNotMatch(html, /Load blocklist/i);
  assert.doesNotMatch(html, /Add timed role/i);
});

test("authenticated admin dashboard renders the webhooks workspace on /admin/guild-1/webhooks", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/webhooks" />);

  assert.match(html, /aria-current="page"[^>]*>[\s\S]*?Webhooks<\/span><\/a>/);
  assert.match(html, /Create and manage inbound webhook proxy URLs and Discord delivery routes\./);
  assert.match(html, /id="sidebar-guild"/);
  assert.doesNotMatch(html, /No server selected/i);
  assert.doesNotMatch(html, /Load blocklist/i);
  assert.doesNotMatch(html, /Add timed role/i);
});

test("authenticated admin dashboard renders webhook content replacement controls", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/webhooks" />);

  assert.match(html, /Content replacements/);
  assert.match(html, /Add replacement/);
  assert.match(html, /Add CFTools profile rule/);
  assert.match(html, /Test configuration/);
  assert.match(html, /Sample payload/);
});

test("authenticated admin dashboard renders Steam Link custom link controls", () => {
  const html = renderToString(
    <App initialAuthenticated initialPath="/admin/guild-1/player-link" />,
  );

  assert.match(html, /Custom links/);
  assert.match(html, /Add custom link/);
  assert.match(html, /\{steamId64\}/);
  assert.match(html, /Sample SteamID64/);
});

test("authenticated admin dashboard renders Xbox Link without Steam-only controls", () => {
  const html = renderToString(
    <App
      initialAuthenticated
      initialPath="/admin/guild-1/player-link"
      initialSearch="?platform=xbox"
    />,
  );

  assert.match(html, /Player Link/);
  assert.match(html, /Xbox link overview/);
  assert.match(html, /Xbox linked role/);
  assert.match(html, /Link your Xbox account/);
  assert.match(html, /Link Xbox/);
  assert.doesNotMatch(html, /Link your Steam account/);
  assert.doesNotMatch(html, /Link Steam</);
  assert.doesNotMatch(html, /Required Steam App IDs/);
  assert.doesNotMatch(html, /Ownership checks/);
  assert.doesNotMatch(html, /\{steamId64\}/);
  assert.doesNotMatch(html, /Sample SteamID64/);
});

test("untouched new Event draft starts pristine", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/events" />);

  assert.match(html, /Create an event/);
  assert.doesNotMatch(html, /Unsaved changes/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[\s\S]*?Create event[\s\S]*?<\/button>/);
});

test("authenticated admin dashboard renders Steam Link panel preview with Steam defaults", () => {
  const html = renderToString(
    <App initialAuthenticated initialPath="/admin/guild-1/player-link" />,
  );

  assert.match(html, /Link your Steam account/);
  assert.match(html, /Link Steam/);
  assert.doesNotMatch(html, /Link your Xbox account/);
  assert.doesNotMatch(html, /Link Xbox/);
});

test("/admin with no guild renders the guild picker shell without editor content", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin" />);

  assert.match(html, /id="sidebar-guild"/);
  assert.match(html, /data-current-path="\/admin"/);
  assert.doesNotMatch(html, /Load ticket panel/i);
  assert.doesNotMatch(html, /Load timed roles/i);
  assert.doesNotMatch(html, /Load blocklist/i);
});

test("timed role DM preview renders supported placeholders", () => {
  assert.equal(
    renderTimedRoleDmPreview("Hi {username}, you got {rolename} in {guild} for {duration}.", {
      duration: "1w",
      roleName: "Newbie",
    }),
    "Hi ExampleUser, you got Newbie in Example Guild for 1w.",
  );
  assert.equal(
    renderTimedRoleDmPreview("", { duration: "1h", roleName: "Member" }),
    "No assignment DM will be sent.",
  );
});

test("getDashboardPageDataPolicy scopes loads to the active page", () => {
  const helper = (AdminAppModule as Record<string, unknown>).getDashboardPageDataPolicy;

  assert.equal(typeof helper, "function");
  const getDashboardPageDataPolicy = helper as (path: string) => {
    loadOverview: boolean;
    loadGuildDirectory: boolean;
    monitorGateway: boolean;
    refreshOverviewAfterGatewayStart: boolean;
  };

  assert.deepEqual(getDashboardPageDataPolicy("/admin"), {
    loadOverview: true,
    loadGuildDirectory: true,
    monitorGateway: true,
    refreshOverviewAfterGatewayStart: true,
  });
  assert.deepEqual(getDashboardPageDataPolicy("/admin/guild-1/blocklist"), {
    loadOverview: false,
    loadGuildDirectory: true,
    monitorGateway: false,
    refreshOverviewAfterGatewayStart: false,
  });
  assert.deepEqual(getDashboardPageDataPolicy("/admin/guild-1/timed-roles"), {
    loadOverview: false,
    loadGuildDirectory: true,
    monitorGateway: false,
    refreshOverviewAfterGatewayStart: false,
  });
  assert.deepEqual(getDashboardPageDataPolicy("/admin/guild-1/tickets"), {
    loadOverview: false,
    loadGuildDirectory: true,
    monitorGateway: false,
    refreshOverviewAfterGatewayStart: false,
  });
  assert.deepEqual(getDashboardPageDataPolicy("/admin/guild-1/troubleshooting"), {
    loadOverview: false,
    loadGuildDirectory: true,
    monitorGateway: false,
    refreshOverviewAfterGatewayStart: false,
  });
  assert.deepEqual(getDashboardPageDataPolicy("/admin/guild-1/webhooks"), {
    loadOverview: false,
    loadGuildDirectory: true,
    monitorGateway: false,
    refreshOverviewAfterGatewayStart: false,
  });
});

test("getEffectiveDashboardPageDataPolicy keeps customer guild directory available on overview", () => {
  const helper = (AdminAppModule as Record<string, unknown>).getEffectiveDashboardPageDataPolicy;

  assert.equal(typeof helper, "function");
  const getEffectiveDashboardPageDataPolicy = helper as (path: string) => {
    loadOverview: boolean;
    loadGuildDirectory: boolean;
    monitorGateway: boolean;
    refreshOverviewAfterGatewayStart: boolean;
  };

  assert.deepEqual(getEffectiveDashboardPageDataPolicy("/admin"), {
    loadOverview: true,
    loadGuildDirectory: true,
    monitorGateway: false,
    refreshOverviewAfterGatewayStart: false,
  });
  assert.deepEqual(getEffectiveDashboardPageDataPolicy("/admin/guild-1/tickets"), {
    loadOverview: false,
    loadGuildDirectory: true,
    monitorGateway: false,
    refreshOverviewAfterGatewayStart: false,
  });
});

test("getSelectedGuildIdFromPath reads the guild from the dashboard path", () => {
  const helper = (AdminAppModule as Record<string, unknown>).getSelectedGuildIdFromPath;

  assert.equal(typeof helper, "function");
  const getSelectedGuildIdFromPath = helper as (path: string) => string;

  assert.equal(getSelectedGuildIdFromPath("/admin/guild-2"), "guild-2");
  assert.equal(getSelectedGuildIdFromPath("/admin/guild-2/tickets"), "guild-2");
  assert.equal(getSelectedGuildIdFromPath("/admin"), "");
  assert.equal(getSelectedGuildIdFromPath("/admin/login"), "");
  assert.equal(getSelectedGuildIdFromPath("/admin/workspaces"), "");
});

test("getSelectedWorkspaceIdFromSearch reads the workspace from the URL query", () => {
  const helper = (AdminAppModule as Record<string, unknown>).getSelectedWorkspaceIdFromSearch;

  assert.equal(typeof helper, "function");
  const getSelectedWorkspaceIdFromSearch = helper as (search: string) => string;

  assert.equal(getSelectedWorkspaceIdFromSearch("?workspaceId=workspace-1"), "workspace-1");
  assert.equal(getSelectedWorkspaceIdFromSearch("?workspaceId="), "");
  assert.equal(getSelectedWorkspaceIdFromSearch(""), "");
});

test("admin route state policy derives selection from route path and search", () => {
  assert.deepEqual(
    getAdminRouteState({
      pathname: "/admin/billing",
      search: "?guildId=guild-2&tab=invalid",
    }),
    {
      currentPath: "/admin/billing",
      pathGuildId: "",
      selectedGuildId: "guild-2",
      selectedWorkspaceId: "",
      reactionRulesTab: "blocklist",
      playerLinkPlatform: "steam",
      ticketsTab: "panel",
      commerceTab: "offerings",
    },
  );
});

test("admin route state keeps the path guild when a workspace is selected", () => {
  const state = getAdminRouteState({
    pathname: "/admin/1506621206336634923/guild-settings",
    search: "?workspaceId=workspace-1",
  });

  assert.equal(state.pathGuildId, "1506621206336634923");
  assert.equal(state.selectedGuildId, "1506621206336634923");
  assert.equal(state.selectedWorkspaceId, "workspace-1");
});

test("admin route state policy resolves default Guild targets", () => {
  assert.equal(
    getDefaultAdminRedirectTarget({
      currentPath: "/admin",
      search: "",
      selectedWorkspaceId: "",
      selectedGuildId: "",
      guildDirectory: [{ guildId: "guild-1", name: "Alpha", label: "Alpha", icon: null }],
      defaultGuildId: null,
      hiddenGuildIds: [],
      preferencesLoading: false,
      lastUsedGuildId: null,
    }),
    "/admin/guild-1",
  );

  assert.equal(
    getDefaultAdminRedirectTarget({
      currentPath: "/admin",
      search: "",
      selectedWorkspaceId: "",
      selectedGuildId: "",
      guildDirectory,
      defaultGuildId: null,
      hiddenGuildIds: [],
      preferencesLoading: false,
      lastUsedGuildId: null,
    }),
    "/admin/guild-1",
  );

  assert.equal(
    getDefaultAdminRedirectTarget({
      currentPath: "/admin/billing",
      search: "?plan=premium_plus&frequency=yearly",
      selectedWorkspaceId: "",
      selectedGuildId: "",
      guildDirectory,
      defaultGuildId: null,
      hiddenGuildIds: [],
      preferencesLoading: false,
      lastUsedGuildId: "guild-2",
    }),
    "/admin/billing?plan=premium_plus&frequency=yearly&guildId=guild_guild-2",
  );
});

test("admin route state prefers a visible default guild without replacing explicit routes", () => {
  const base = {
    currentPath: "/admin",
    search: "",
    selectedWorkspaceId: "",
    guildDirectory,
    defaultGuildId: "guild-2",
    hiddenGuildIds: [] as string[],
    preferencesLoading: false,
    lastUsedGuildId: "guild-1",
  };

  assert.equal(getDefaultAdminRedirectTarget({ ...base, selectedGuildId: "" }), "/admin/guild-2");
  assert.equal(getDefaultAdminRedirectTarget({ ...base, selectedGuildId: "guild-1" }), null);
  assert.equal(
    getDefaultAdminRedirectTarget({
      ...base,
      selectedGuildId: "",
      hiddenGuildIds: ["guild-2"],
    }),
    "/admin/guild-1",
  );
  assert.equal(
    getDefaultAdminRedirectTarget({
      ...base,
      selectedGuildId: "",
      preferencesLoading: true,
    }),
    null,
  );
});

test("buildReactionRulesTabHref uses route search for tab state", () => {
  assert.equal(
    buildReactionRulesTabHref(
      "/admin/guild-1/blocklist?workspaceId=workspace-1#limits",
      "blocklist",
    ),
    "/admin/guild-1/blocklist?workspaceId=workspace-1&tab=blocklist",
  );
  assert.equal(
    buildReactionRulesTabHref("/admin/guild-1/blocklist", "limits"),
    "/admin/guild-1/blocklist?tab=limits",
  );
});

test("buildAdminDashboardHref keeps the selected guild in sidebar navigation links", () => {
  const helper = (AdminAppModule as Record<string, unknown>).buildAdminDashboardHref;

  assert.equal(typeof helper, "function");
  const buildAdminDashboardHref = helper as (
    path: string,
    workspaceId: string,
    guildId: string,
  ) => string;

  assert.equal(buildAdminDashboardHref("/admin/tickets", "", "guild-2"), "/admin/guild-2/tickets");
  assert.equal(
    buildAdminDashboardHref("/admin/guild-1/tickets", "", "guild-2"),
    "/admin/guild-2/tickets",
  );
  assert.equal(buildAdminDashboardHref("/admin/guild-1", "", "guild-2"), "/admin/guild-2");
  assert.equal(buildAdminDashboardHref("/admin/tickets", "", ""), "/admin");
  assert.equal(buildAdminDashboardHref("/admin/guild-1/tickets", "", ""), "/admin");
  assert.equal(
    buildAdminDashboardHref("/admin/blocklist", "workspace-1", ""),
    "/admin?workspaceId=workspace-1",
  );
  assert.equal(
    buildAdminDashboardHref("/admin/billing", "", "guild-2"),
    "/admin/billing?guildId=guild_guild-2",
  );
  assert.equal(
    buildAdminDashboardHref("/admin/billing", "workspace-1", "guild-2"),
    "/admin/billing?workspaceId=workspace-1&guildId=guild_guild-2",
  );
});

test("buildGuildScopedViewInstanceKey changes when dashboard refresh version changes", () => {
  const helper = (AdminAppModule as Record<string, unknown>).buildGuildScopedViewInstanceKey;

  assert.equal(typeof helper, "function");
  const buildGuildScopedViewInstanceKey = helper as (
    workspaceId: string,
    guildId: string,
    refreshVersion: number,
  ) => string;

  assert.equal(
    buildGuildScopedViewInstanceKey("workspace-1", "guild-1", 0),
    "workspace-1:guild-1:0",
  );
  assert.equal(
    buildGuildScopedViewInstanceKey("workspace-1", "guild-1", 1),
    "workspace-1:guild-1:1",
  );
});

test("combineDashboardErrors preserves both overview and gateway failures", () => {
  assert.equal(
    combineDashboardErrors("Overview failed.", "Gateway failed."),
    "Overview failed. Gateway failed.",
  );
  assert.equal(combineDashboardErrors(null, "Gateway failed."), "Gateway failed.");
  assert.equal(combineDashboardErrors("Overview failed.", null), "Overview failed.");
  assert.equal(combineDashboardErrors(null, null), null);
});

test("describeError collapses HTML worker failures into a friendly dashboard message", () => {
  const helper = (AdminAppModule as Record<string, unknown>).describeError;

  assert.equal(typeof helper, "function");
  const describeError = helper as (error: unknown) => string;

  assert.equal(
    describeError(
      new Error("<!DOCTYPE html><html><head><title>Worker threw exception</title></head></html>"),
    ),
    "Discord lookup failed right now.",
  );
});

test("readJsonOrThrow shows friendly Discord rate limit JSON errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    adminErrorResponse("Discord is rate limiting server discovery. Try again shortly.", 429, {
      code: "discord_rate_limited",
    });

  try {
    await assert.rejects(readJsonOrThrow("/admin/api/guilds"), {
      message: "Discord is rate limiting server discovery. Try again shortly.",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("describeError asks users to reconnect Discord when server-list access is missing", () => {
  const helper = (AdminAppModule as Record<string, unknown>).describeError;

  assert.equal(typeof helper, "function");
  const describeError = helper as (error: unknown) => string;

  assert.equal(
    describeError(new Error("Missing Discord OAuth access token for guild lookup.")),
    "Please sign out and sign back in with Discord to grant server-list access.",
  );
});

test("authenticated admin dashboard keeps the initial dashboard path available to the client shell", () => {
  const html = renderToString(<App initialAuthenticated initialPath="/admin/guild-1/tickets" />);

  assert.match(html, /data-current-path="\/admin\/guild-1\/tickets"/);
});

test("customer social dashboard keeps the standard logout target and guild selector", () => {
  const html = renderToString(<App initialAuthenticated />);
  const dom = JSDOM.fragment(html);
  assert.ok(dom.querySelector('form[method="post"][action="/admin/logout"]'));
  assert.ok(dom.querySelector("#sidebar-guild"));
});

test("closed tickets section renders transcript capability actions and pagination status", () => {
  const html = renderToString(
    <ClosedTicketsSection
      guildId="guild-1"
      tickets={[
        {
          guildId: "guild-1",
          channelId: "channel-1",
          ticketTypeId: "appeals",
          ticketTypeLabel: "Appeal",
          openerUserId: "user-1",
          supportRoleId: "role-1",
          status: "closed",
          answers: [],
          openedAtMs: 1_700_000_000_000,
          closedAtMs: 1_700_000_100_000,
          closedByUserId: "staff-1",
          transcriptMessageId: "transcript-1",
          staffThreadId: null,
        },
      ]}
      total={3}
      nextCursor={1_700_000_000_000}
      loading={false}
      onLoadMore={() => {}}
    />,
  );

  assert.match(html, /Closed Tickets/);
  assert.match(html, /1 of 3 closed tickets/);
  assert.match(html, /channel-1/);
  assert.match(html, /Appeal/);
  assert.match(html, /user-1/);
  assert.doesNotMatch(html, /href="\/transcripts\/guild-1\/channel-1"/);
  assert.match(html, /Generate link/);
  assert.match(html, /Revoke/);
  assert.match(html, /Load more/);
});

test("ticket panel save state changes only when the panel config changes", () => {
  const savedPanel = {
    guildId: "guild-1",
    panelChannelId: "panel-channel-1",
    categoryChannelId: "category-1",
    transcriptChannelId: "transcript-1",
    panelEmoji: null,
    panelTitle: "Support tickets",
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    ticketTypes: [],
  };

  assert.equal(areTicketPanelConfigsEqual(savedPanel, { ...savedPanel }), true);
  assert.equal(
    areTicketPanelConfigsEqual(savedPanel, { ...savedPanel, panelTitle: "Open a ticket" }),
    false,
  );
});

test("ticket panel editor shows friendly Discord names instead of raw IDs", () => {
  const html = renderToString(
    <TicketPanelEditor
      guildResources={{
        guildId: "guild-1",
        roles: [{ id: "role-1", name: "Support" }],
        categories: [{ id: "category-1", name: "Open Tickets" }],
        textChannels: [{ id: "transcript-1", name: "ticket-transcripts" }],
      }}
      value={{
        guildId: "guild-1",
        panelChannelId: "panel-channel-1",
        categoryChannelId: "category-1",
        transcriptChannelId: "transcript-1",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [],
      }}
      onChange={() => {}}
    />,
  );

  assert.match(html, />Open Tickets</);
  assert.match(html, />ticket-transcripts</);
  assert.doesNotMatch(html, />category-1</);
});

test("ticket panel editor renders panel controls on the Panel tab", () => {
  const html = renderToString(
    <TicketPanelEditor
      guildResources={{
        guildId: "guild-1",
        roles: [{ id: "role-1", name: "Support" }],
        categories: [{ id: "category-1", name: "Open Tickets" }],
        textChannels: [{ id: "transcript-1", name: "ticket-transcripts" }],
      }}
      value={{
        guildId: "guild-1",
        panelChannelId: "panel-channel-1",
        categoryChannelId: "category-1",
        transcriptChannelId: "transcript-1",
        panelEmoji: "🎫",
        panelTitle: "COLD AS F**K tickets",
        panelDescription: "To create a ticket use the Create ticket button",
        panelFooter: "TicketTool.xyz - Ticketing without clutter",
        panelMessageId: null,
        ticketCreationLimit: 5,
        ticketLimitRejectionMessage: "Please close an existing ticket first.",
        enableTicketClaiming: true,
        ticketTypes: [],
      }}
      onChange={() => {}}
      tab="panel"
    />,
  );

  assert.match(html, /Panel title/);
  assert.match(html, /Embed emoji/);
  assert.match(html, /Panel description/);
  assert.match(html, /Panel footer/);
  assert.match(html, /COLD AS F\*\*K tickets/);
  assert.match(html, /To create a ticket use the Create ticket button/);
  assert.doesNotMatch(html, /Ticket Rules/);
  assert.doesNotMatch(html, /Ticket Types/);
});

test("ticket panel editor renders rules controls on the Rules tab", () => {
  const html = renderToString(
    <TicketPanelEditor
      guildResources={{
        guildId: "guild-1",
        roles: [{ id: "role-1", name: "Support" }],
        categories: [{ id: "category-1", name: "Open Tickets" }],
        textChannels: [{ id: "transcript-1", name: "ticket-transcripts" }],
      }}
      value={{
        guildId: "guild-1",
        panelChannelId: "panel-channel-1",
        categoryChannelId: "category-1",
        transcriptChannelId: "transcript-1",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: 5,
        ticketLimitRejectionMessage: "Please close an existing ticket first.",
        enableTicketClaiming: true,
        ticketTypes: [],
      }}
      onChange={() => {}}
      tab="rules"
    />,
  );

  assert.match(html, /Ticket Rules/);
  assert.match(html, /Enable ticket claiming/);
  assert.match(html, /Ticket creation limit/);
  assert.match(html, /Limit rejection message/);
  assert.doesNotMatch(html, /Panel Settings/);
  assert.doesNotMatch(html, /Ticket Types/);
});

test("ticket panel editor renders types and questions on the Types tab", () => {
  const html = renderToString(
    <TicketPanelEditor
      guildResources={{
        guildId: "guild-1",
        roles: [
          { id: "role-1", name: "Support" },
          { id: "role-2", name: "Supporters" },
        ],
        categories: [{ id: "category-1", name: "Open Tickets" }],
        textChannels: [{ id: "transcript-1", name: "ticket-transcripts" }],
      }}
      value={{
        guildId: "guild-1",
        panelChannelId: "panel-channel-1",
        categoryChannelId: "category-1",
        transcriptChannelId: "transcript-1",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [
          {
            id: "appeals",
            label: "Appeal",
            emoji: "🧾",
            buttonStyle: "primary",
            supportRoleId: "role-1",
            allowedCreatorRoleIds: ["role-2"],
            channelNamePrefix: "appeal",
            responseRules: [
              {
                id: "rule-1",
                conditions: [{ kind: "lacks-role", roleId: "role-2" }],
                message: "Please run /steamlink.",
              },
            ],
            anonymousSupportEnabled: false,
            staffDiscussionThreadEnabled: false,
            limitExclusion: true,
            mentionSupportRole: true,
            questions: [
              {
                id: "reason",
                label: "Steam ID",
                style: "paragraph",
                placeholder: "Explain the issue",
                required: true,
                validation: "steamId",
              },
            ],
          },
        ],
      }}
      onChange={() => {}}
      tab="types"
    />,
  );

  assert.match(html, /Add ticket type/);
  assert.match(html, /Collapse all/);
  assert.match(html, /<details class="group rounded-md border bg-background" open="">/);
  assert.match(html, /Add question/);
  assert.match(html, /Ticket type label/);
  assert.match(html, /Response rules/);
  assert.match(html, /Add response rule/);
  assert.match(html, /Response message/);
  assert.match(html, /Conditions \(all must match\)/);
  assert.match(html, /Support role/);
  assert.match(html, /Allowed creator roles/);
  assert.match(html, /Supporters/);
  assert.match(html, /Mention support role on ticket creation/);
  assert.match(html, /Allow staff to add participants/);
  assert.match(html, /existing Ticket history, attachments, and future participant messages/);
  assert.match(html, /Steam ID/);
  assert.match(html, /Question validation/);
  assert.match(html, /Steam ID/);
  assert.match(html, /role="combobox"/);
  assert.match(html, /Support role/);
  assert.match(html, /role="combobox"/);
  assert.doesNotMatch(html, /Panel Settings/);
  assert.doesNotMatch(html, /Ticket Rules/);
});

function renderTicketQuestionEditor(
  question: TicketQuestion,
  options: { ticketTypeId?: string; ticketTypeLabel?: string; panelId?: string } = {},
): string {
  return renderToString(
    <TicketPanelEditor
      guildResources={{
        guildId: "guild-1",
        roles: [{ id: "role-1", name: "Support" }],
        categories: [{ id: "category-1", name: "Open Tickets" }],
        textChannels: [{ id: "transcript-1", name: "ticket-transcripts" }],
      }}
      value={{
        guildId: "guild-1",
        panelId: options.panelId,
        panelChannelId: "panel-channel-1",
        categoryChannelId: "category-1",
        transcriptChannelId: "transcript-1",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [
          {
            id: options.ticketTypeId ?? "support",
            label: options.ticketTypeLabel ?? "Support",
            emoji: null,
            buttonStyle: "primary",
            supportRoleId: "role-1",
            channelNamePrefix: "support",
            questions: [question],
            limitExclusion: false,
            responseRules: [],
          },
        ],
      }}
      onChange={() => {}}
      tab="types"
    />,
  );
}

test("Ticket question editor keeps an over-limit label visible with its inline limit", () => {
  const label = "L".repeat(46);
  const html = renderTicketQuestionEditor({
    id: "reason",
    label,
    style: "short",
    placeholder: null,
    required: true,
  });

  assert.match(html, new RegExp(`value="${label}"`));
  assert.match(html, /maxLength="45"/);
  assert.match(html, /46.*45.*characters/);
  assert.match(html, /Question label must be 45 characters or fewer\./);
});

test("Ticket question editor keeps an over-limit Question ID visible with its inline limit", () => {
  const id = "q".repeat(101);
  const html = renderTicketQuestionEditor({
    id,
    label: "Reason",
    style: "short",
    placeholder: null,
    required: true,
  });

  assert.match(html, new RegExp(`value="${id}"`));
  assert.match(html, /maxLength="100"/);
  assert.match(html, /101.*100.*characters/);
  assert.match(html, /Question ID must be 100 characters or fewer\./);
});

test("Ticket question editor keeps an over-limit placeholder visible with its inline limit", () => {
  const placeholder = "P".repeat(101);
  const html = renderTicketQuestionEditor({
    id: "reason",
    label: "Reason",
    style: "short",
    placeholder,
    required: true,
  });

  assert.match(html, new RegExp(`value="${placeholder}"`));
  assert.match(html, /id="tp-question-placeholder-0-0"[^>]*maxLength="100"/);
  assert.match(html, /101.*100.*characters/);
  assert.match(html, /Placeholder must be 100 characters or fewer\./);
});

test("Ticket type editor keeps an over-limit label visible with its inline limit", () => {
  const label = "L".repeat(46);
  const html = renderTicketQuestionEditor(
    {
      id: "reason",
      label: "Reason",
      style: "short",
      placeholder: null,
      required: true,
    },
    { ticketTypeLabel: label },
  );

  assert.match(html, new RegExp(`value="${label}"`));
  assert.match(html, /id="tp-ticket-label-0"[^>]*maxLength="45"/);
  assert.match(html, /46.*45.*characters/);
  assert.match(html, /Ticket Type label must be 45 characters or fewer\./);
});

test("Ticket type editor keeps an over-limit composed open ID visible with its inline limit", () => {
  const id = "t".repeat(84);
  const html = renderTicketQuestionEditor(
    {
      id: "reason",
      label: "Reason",
      style: "short",
      placeholder: null,
      required: true,
    },
    { ticketTypeId: id },
  );

  assert.match(html, new RegExp(`value="${id}"`));
  assert.match(html, /id="tp-ticket-id-0"[^>]*maxLength="83"/);
  assert.match(html, /101.*100.*characters/);
  assert.match(html, /Ticket Type open custom ID must be 100 characters or fewer\./);
});

function createTicketPanelWithQuestion(question: TicketQuestion): TicketPanelConfig {
  return {
    guildId: "guild-1",
    panelChannelId: "panel-channel-1",
    categoryChannelId: "category-1",
    transcriptChannelId: "transcript-1",
    panelEmoji: null,
    panelTitle: null,
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    ticketTypes: [
      {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary",
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        questions: [question],
        limitExclusion: false,
        responseRules: [],
      },
    ],
  };
}

test("Ticket panel submit validation identifies an over-limit question label", () => {
  const label = "L".repeat(46);

  assert.equal(
    validateTicketPanelBeforeSubmit(
      createTicketPanelWithQuestion({
        id: "reason",
        label,
        style: "short",
        placeholder: null,
        required: true,
      }),
    ),
    `Ticket Type "Support", question 1 ("${label}"): Question label must be 45 characters or fewer.`,
  );
});

test("Ticket panel submit validation identifies an over-limit Question ID", () => {
  const id = "q".repeat(101);

  assert.equal(
    validateTicketPanelBeforeSubmit(
      createTicketPanelWithQuestion({
        id,
        label: "Reason",
        style: "short",
        placeholder: null,
        required: true,
      }),
    ),
    'Ticket Type "Support", question 1 ("Reason"): Question ID must be 100 characters or fewer.',
  );
});

test("Ticket panel submit validation identifies an over-limit placeholder", () => {
  assert.equal(
    validateTicketPanelBeforeSubmit(
      createTicketPanelWithQuestion({
        id: "reason",
        label: "Reason",
        style: "short",
        placeholder: "P".repeat(101),
        required: true,
      }),
    ),
    'Ticket Type "Support", question 1 ("Reason"): Placeholder must be 100 characters or fewer.',
  );
});

test("Ticket panel submit validation identifies an over-limit Ticket Type label", () => {
  const label = "L".repeat(46);
  const panel = createTicketPanelWithQuestion({
    id: "reason",
    label: "Reason",
    style: "short",
    placeholder: null,
    required: true,
  });
  panel.ticketTypes[0]!.label = label;

  assert.equal(
    validateTicketPanelBeforeSubmit(panel),
    `Ticket Type "${label}": Ticket Type label must be 45 characters or fewer.`,
  );
});

test("Ticket panel submit validation identifies an over-limit composed Ticket Type open ID", () => {
  const id = "t".repeat(84);
  const panel = createTicketPanelWithQuestion({
    id: "reason",
    label: "Reason",
    style: "short",
    placeholder: null,
    required: true,
  });
  panel.ticketTypes[0]!.id = id;

  assert.equal(
    validateTicketPanelBeforeSubmit(panel),
    `Ticket Type "Support": Ticket Type open custom ID must be 100 characters or fewer (currently 101).`,
  );
});

test("ticket panel editor warns when a response-rule role no longer exists", () => {
  const html = renderToString(
    <TicketPanelEditor
      guildResources={{
        guildId: "guild-1",
        roles: [{ id: "role-1", name: "Support" }],
        categories: [{ id: "category-1", name: "Open Tickets" }],
        textChannels: [{ id: "transcript-1", name: "ticket-transcripts" }],
      }}
      value={{
        guildId: "guild-1",
        panelChannelId: "panel-channel-1",
        categoryChannelId: "category-1",
        transcriptChannelId: "transcript-1",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [
          {
            id: "appeals",
            label: "Appeal",
            emoji: null,
            buttonStyle: "primary",
            supportRoleId: "role-1",
            channelNamePrefix: "appeal",
            responseRules: [
              {
                id: "rule-1",
                conditions: [{ kind: "has-role", roleId: "deleted-role" }],
                message: "Please verify your account.",
              },
            ],
            anonymousSupportEnabled: false,
            staffDiscussionThreadEnabled: false,
            limitExclusion: false,
            questions: [],
          },
        ],
      }}
      onChange={() => {}}
      tab="types"
    />,
  );

  assert.match(html, /This role no longer exists in the guild/);
});

test("ticket panel editor hides rule and condition add buttons at response-rule caps", () => {
  const cappedRules = Array.from({ length: 10 }, (_, ruleIndex) => ({
    id: `rule-${ruleIndex + 1}`,
    conditions: Array.from({ length: 5 }, (_, conditionIndex) => ({
      kind: "has-role" as const,
      roleId: `role-${conditionIndex + 1}`,
    })),
    message: `Rule ${ruleIndex + 1}`,
  }));

  const html = renderToString(
    <TicketPanelEditor
      guildResources={{
        guildId: "guild-1",
        roles: [
          { id: "role-1", name: "Support" },
          { id: "role-2", name: "Verified" },
          { id: "role-3", name: "Steam Linked" },
          { id: "role-4", name: "Member" },
          { id: "role-5", name: "Staff" },
        ],
        categories: [{ id: "category-1", name: "Open Tickets" }],
        textChannels: [{ id: "transcript-1", name: "ticket-transcripts" }],
      }}
      value={{
        guildId: "guild-1",
        panelChannelId: "panel-channel-1",
        categoryChannelId: "category-1",
        transcriptChannelId: "transcript-1",
        panelEmoji: null,
        panelTitle: null,
        panelDescription: null,
        panelFooter: null,
        panelMessageId: null,
        ticketCreationLimit: null,
        ticketLimitRejectionMessage: null,
        enableTicketClaiming: false,
        ticketTypes: [
          {
            id: "appeals",
            label: "Appeal",
            emoji: null,
            buttonStyle: "primary",
            supportRoleId: "role-1",
            channelNamePrefix: "appeal",
            responseRules: cappedRules,
            anonymousSupportEnabled: false,
            staffDiscussionThreadEnabled: false,
            limitExclusion: false,
            questions: [],
          },
        ],
      }}
      onChange={() => {}}
      tab="types"
    />,
  );

  assert.doesNotMatch(html, /Add response rule/);
  assert.doesNotMatch(html, /Add condition/);
});

function createTestAdminRouterContext(
  overrides: Partial<AdminRouterContext> = {},
): AdminRouterContext {
  return {
    currentPath: "/admin",
    currentSearch: "",
    selectedWorkspaceId: "",
    selectedGuildId: "",
    pathGuildId: "",
    reactionRulesTab: "blocklist",
    playerLinkPlatform: "steam",
    ticketsTab: "panel",
    commerceTab: "offerings",
    defaultRedirectTarget: null,
    guildDirectory: null,
    guildLookupError: null,
    workspaces: [],
    workspacesLoading: false,
    workspaceLookupError: null,
    guildResourcesRefreshVersion: 0,
    onSelectedGuildChange: () => {},
    onSelectedWorkspaceChange: () => {},
    refreshGuildDirectory: async () => {},
    onRefresh: async () => {},
    playstationLinkEnabled: true,
    entitlement: null,
    userProfile: {
      name: "Admin User",
      email: "",
      image: "",
    },
    userPreferences: {
      hiddenGuildIds: [],
      defaultGuildId: null,
      emailNotifications: true,
      pushNotifications: false,
      theme: "system",
      language: "en",
    },
    applyUserPreferencesPatch: async () => undefined,
    pageMetadata: null,
    setPageMetadata: (_metadata: AdminPageMetadata | null) => {},
    isRoutePending: false,
    ...overrides,
  };
}
