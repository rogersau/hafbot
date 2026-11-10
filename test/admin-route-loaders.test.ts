/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import { createMemoryHistory, createRouter } from "@tanstack/react-router";
import { routeTree } from "../src/admin/routes/route-tree";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import {
  loadBlocklistRoute,
  loadEvidenceVaultRoute,
  loadGuildOverviewRoute,
  loadGuildSettingsRoute,
  loadManagedMessagesRoute,
  loadMemberVerificationRoute,
  loadMentionProtectionRoute,
  loadPlayerLinkRoute,
  loadProfileRoute,
} from "../src/admin/lib/admin-route-loaders";
import { resetGuildResourcesCache } from "../src/admin/lib/guild-resources-cache";
import { getGuildEntitlementLimits, type MentionProtectionConfig } from "../src/types";
import { AdminApiError } from "../src/admin/lib/api";
import { AdminContractViolationError } from "../src/admin/generated/admin-client/core";
import { createDefaultMentionProtectionConfig } from "../src/services/mention-protection/message-handler";

test("Guild Settings isolates privacy read errors but preserves authorization failures", async () => {
  const originalFetch = globalThis.fetch;
  let status = 500;
  let code = "internal_error";
  globalThis.fetch = async (input) =>
    String(input).startsWith("/admin/api/product-analytics/")
      ? Response.json(
          {
            error: "Unavailable",
            code,
            correlationId: "fictional-ref",
            retryable: true,
            action: "retry",
          },
          { status },
        )
      : Response.json({
          guildId: "guild-1",
          adminRoleId: "admin-role-1",
          manageServerAdminEnabled: true,
          canManageDelegation: false,
          canManageServerPolicy: false,
        });
  const context = { params: { guildId: "guild-1" }, location: { searchStr: "" } };
  try {
    const result = await loadGuildSettingsRoute(context);
    assert.equal(result.data.adminRoleId, "admin-role-1");
    assert.equal(result.data.productAnalyticsEnabled, undefined);
    assert.ok(result.data.productAnalyticsError instanceof AdminApiError);
    for (status of [401, 403]) {
      code = status === 401 ? "authentication_required" : "permission_denied";
      await assert.rejects(
        loadGuildSettingsRoute(context),
        (error: unknown) => error instanceof AdminApiError && error.status === status,
      );
    }
    code = "internal_error";
    await assert.rejects(
      loadGuildSettingsRoute(context),
      (error: unknown) => error instanceof AdminContractViolationError && error.status === 403,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Overview omits an empty workspace, accepts attention cards, and exposes fetch failures", async () => {
  const originalFetch = globalThis.fetch;
  let fail = false;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input), "https://example.test");
    assert.equal(url.searchParams.has("workspaceId"), false);
    if (url.pathname === "/admin/api/guild-overview") {
      return fail
        ? Response.json(
            {
              error: "Unavailable",
              code: "internal_error",
              correlationId: "fictional-ref",
              retryable: true,
              action: "retry",
            },
            { status: 500 },
          )
        : Response.json({
            guildId: "guild-1",
            tier: "free",
            cards: [
              {
                id: "tickets",
                label: "Tickets",
                path: "/admin/tickets",
                status: "attention",
                detail: "Needs review",
                locked: false,
                attentionCount: 1,
                highestSeverity: "warning",
                attentionSummary: "Needs review",
              },
            ],
          });
    }
    if (url.pathname === "/admin/api/entitlement")
      return Response.json({
        tier: "free",
        limits: getGuildEntitlementLimits("free"),
        supportInvite: null,
        r2Usage: { usedBytes: 0, reservedBytes: 0, maxBytes: 100, lastReconciledAtMs: null },
      });
    if (url.pathname.endsWith("/capabilities")) return Response.json({ canWrite: true });
    return Response.json({ incidents: [] });
  };
  try {
    const context = { params: { guildId: "guild-1" }, location: { searchStr: "" } };
    assert.equal((await loadGuildOverviewRoute(context)).data.overview?.cards.length, 1);
    fail = true;
    await assert.rejects(loadGuildOverviewRoute(context), AdminApiError);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("guild route navigation and invalidation share one current entitlement read", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  let tier: "free" | "premium" = "free";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://fixture.local");
    requests.push(url.pathname + url.search);
    if (url.pathname === "/admin/api/entitlement") {
      const limits = getGuildEntitlementLimits(tier);
      return Response.json({
        tier,
        limits,
        supportInvite: null,
        r2Usage: {
          usedBytes: 0,
          reservedBytes: 0,
          maxBytes: limits.r2MaxBytes,
          lastReconciledAtMs: null,
        },
      });
    }
    if (url.pathname === "/admin/api/guild-overview") {
      return Response.json({ guildId: "guild-1", tier, cards: [] });
    }
    if (url.pathname === "/admin/api/operations/incidents/capabilities") {
      return Response.json({ canWrite: false });
    }
    if (url.pathname === "/admin/api/product-analytics/events") return Response.json({});
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  try {
    const router = createRouter({
      routeTree,
      history: createMemoryHistory({
        initialEntries: ["/admin/guild-1?workspaceId=workspace-1"],
      }),
      context: {} as typeof routeTree.types.routerContext,
    });
    const assertEntitlement = (workspaceId: string) => {
      const shell = router.state.matches.find((match) => match.routeId === "/admin/$guildId");
      const page = router.state.matches.find((match) => match.routeId === "/admin/$guildId/");
      assert.equal(shell?.loaderData?.data.workspaceId, workspaceId);
      assert.equal(shell?.loaderData?.data.entitlement?.tier, tier);
      assert.equal(page?.loaderData?.data.entitlement?.tier, tier);
      assert.equal(requests.filter((url) => url.startsWith("/admin/api/entitlement?")).length, 1);
      requests.length = 0;
    };

    await router.load();
    assertEntitlement("workspace-1");
    tier = "premium";
    await router.navigate({
      to: "/admin/$guildId",
      params: { guildId: "guild-1" },
      search: { workspaceId: "workspace-2" },
    });
    assertEntitlement("workspace-2");
    tier = "free";
    await router.invalidate({ sync: true });
    assertEntitlement("workspace-2");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("guild child loaders ignore a parent entitlement for another guild or workspace", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const limits = getGuildEntitlementLimits("free");
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/admin/api/entitlement?")) {
      return Response.json({
        tier: "free",
        limits,
        supportInvite: null,
        r2Usage: {
          usedBytes: 0,
          reservedBytes: 0,
          maxBytes: limits.r2MaxBytes,
          lastReconciledAtMs: null,
        },
      });
    }
    if (url.startsWith("/admin/api/guild-overview?")) {
      return Response.json({ guildId: "guild-1", tier: "free", cards: [] });
    }
    if (url.startsWith("/admin/api/operations/incidents/capabilities?")) {
      return Response.json({ canWrite: false });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const result = await loadGuildOverviewRoute({
      params: { guildId: "guild-1" },
      location: { searchStr: "?workspaceId=workspace-1" },
      parentMatchPromise: Promise.resolve({
        loaderData: {
          data: { guildId: "guild-2", workspaceId: "workspace-2", entitlement: null },
        },
      }),
    });

    assert.equal(result.data.entitlement?.tier, "free");
    assert.equal(requests.filter((url) => url.startsWith("/admin/api/entitlement?")).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadProfileRoute only loads the guild directory used by the profile page", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url === "/admin/api/guilds") return Response.json({ guilds: [] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const result = await loadProfileRoute({});

    assert.deepEqual(result.data.guilds, []);
    assert.deepEqual(requests, ["/admin/api/guilds"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadGuildSettingsRoute supports guild-admin access without a workspace", async () => {
  const originalFetch = globalThis.fetch;
  const requestedUrls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const requestedUrl = String(input);
    requestedUrls.push(requestedUrl);
    if (requestedUrl.startsWith("/admin/api/product-analytics/preference?")) {
      return Response.json({ guildId: "guild-1", enabled: true });
    }
    return Response.json({
      guildId: "guild-1",
      adminRoleId: null,
      manageServerAdminEnabled: true,
      canManageDelegation: false,
      canManageServerPolicy: false,
    });
  }) as typeof fetch;

  try {
    const result = await loadGuildSettingsRoute({
      params: { guildId: "guild-1" },
      location: { searchStr: "" },
    });

    assert.equal(result.data.adminRoleId, null);
    assert.equal(result.data.productAnalyticsEnabled, true);
    assert.deepEqual(requestedUrls.sort(), [
      "/admin/api/guild-rbac/admin-role?guildId=guild-1",
      "/admin/api/product-analytics/preference?guildId=guild-1",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadBlocklistRoute loads reaction limits for a Free Guild", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/admin/api/entitlement?")) {
      return Response.json({
        tier: "free",
        limits: {
          blocklistMaxEmojis: 10,
          reactionLimitsEnabled: true,
          ticketsMaxPanels: 1,
          ticketsMaxTypesPerPanel: 1,
          platformLinkMaxLinks: 100,
          managedMessagesMax: 3,
          clansMax: 5,
          clanMembersMax: 25,
          clanOfficersMax: 5,
          messageTemplatesMax: 3,
          evidenceVaultMaxRecords: 30,
          r2MaxBytes: 104857600,
          paidFeatures: false,
        },
        supportInvite: null,
        r2Usage: { usedBytes: 0, reservedBytes: 0, maxBytes: 104857600, lastReconciledAtMs: null },
      });
    }
    if (url.startsWith("/admin/api/blocklist?")) {
      return Response.json({ guildId: "guild-1", emojis: [], channelIds: [] });
    }
    if (url.startsWith("/admin/api/reaction-limits?")) {
      return Response.json({ guildId: "guild-1", config: null, counters: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const result = await loadBlocklistRoute({
      params: { guildId: "guild-1" },
      location: { searchStr: "?workspaceId=workspace-1" },
    });

    assert.equal(result.data.reactionLimits?.config, null);
    assert.deepEqual(result.data.reactionLimits?.counters, []);
    assert.equal(
      requests.some((url) => url.startsWith("/admin/api/reaction-limits?")),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadBlocklistRoute still loads saved reaction limits when entitlement lookup fails", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/admin/api/entitlement?"))
      return new Response("unavailable", { status: 503 });
    if (url.startsWith("/admin/api/blocklist?")) {
      return Response.json({ guildId: "guild-1", emojis: [], channelIds: [] });
    }
    if (url.startsWith("/admin/api/reaction-limits?")) {
      return Response.json({
        guildId: "guild-1",
        config: {
          guildId: "guild-1",
          limitsEnabled: true,
          maxReactionsPerMessage: 5,
          maxReactionsPerUserPerMessage: 1,
          breachThreshold: null,
          breachRoleId: null,
          breachRoleDurationMs: null,
          breachDmText: null,
          channelMode: "include",
          channelIds: [],
        },
        counters: [],
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const result = await loadBlocklistRoute({
      params: { guildId: "guild-1" },
      location: { searchStr: "?workspaceId=workspace-1" },
    });

    assert.equal(result.data.entitlement, null);
    assert.equal(result.data.reactionLimits?.config?.limitsEnabled, true);
    assert.equal(result.data.reactionLimits?.config?.maxReactionsPerMessage, 5);
    assert.equal(
      requests.some((url) => url.startsWith("/admin/api/reaction-limits?")),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadBlocklistRoute reflects Reaction Limits saved before a route refresh", async () => {
  const originalFetch = globalThis.fetch;
  let savedConfig: Record<string, unknown> | null = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/admin/api/entitlement?")) return Response.json({ tier: "free" });
    if (url.startsWith("/admin/api/blocklist?")) {
      return Response.json({ guildId: "guild-1", emojis: [], channelIds: [] });
    }
    if (url.startsWith("/admin/api/reaction-limits/config") && init?.method === "POST") {
      savedConfig = JSON.parse(String(init.body)) as Record<string, unknown>;
      return Response.json({ config: savedConfig });
    }
    if (url.startsWith("/admin/api/reaction-limits?")) {
      return Response.json({ guildId: "guild-1", config: savedConfig, counters: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    await fetch("/admin/api/reaction-limits/config", {
      method: "POST",
      body: JSON.stringify({
        guildId: "guild-1",
        limitsEnabled: true,
        maxReactionsPerMessage: 5,
        maxReactionsPerUserPerMessage: 1,
        breachThreshold: null,
        breachRoleId: null,
        breachRoleDurationMs: null,
        breachDmText: null,
        channelMode: "include",
        channelIds: [],
      }),
    });
    const refreshed = await loadBlocklistRoute({
      params: { guildId: "guild-1" },
      location: { searchStr: "" },
    });

    assert.equal(refreshed.data.reactionLimits?.config?.limitsEnabled, true);
    assert.equal(refreshed.data.reactionLimits?.config?.maxReactionsPerMessage, 5);
    assert.equal(refreshed.data.blocklist.emojis.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadMemberVerificationRoute loads configuration for a Free Guild", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/admin/api/entitlement?")) {
      return Response.json({
        tier: "free",
        limits: {
          blocklistMaxEmojis: 10,
          reactionLimitsEnabled: true,
          ticketsMaxPanels: 1,
          ticketsMaxTypesPerPanel: 1,
          platformLinkMaxLinks: 100,
          managedMessagesMax: 3,
          clansMax: 5,
          clanMembersMax: 25,
          clanOfficersMax: 5,
          messageTemplatesMax: 3,
          evidenceVaultMaxRecords: 30,
          r2MaxBytes: 104857600,
          paidFeatures: false,
        },
        supportInvite: null,
        r2Usage: { usedBytes: 0, reservedBytes: 0, maxBytes: 104857600, lastReconciledAtMs: null },
      });
    }
    if (url.startsWith("/admin/api/member-verification?")) {
      return Response.json({
        guildId: "guild-1",
        config: null,
        paidMethodsAvailable: false,
        turnstileAvailable: false,
        steamLinkAvailable: true,
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const result = await loadMemberVerificationRoute({
      params: { guildId: "guild-1" },
      location: { searchStr: "?workspaceId=workspace-1" },
    });

    assert.equal(result.data.entitlement?.tier, "free");
    assert.equal(result.data.paidMethodsAvailable, false);
    assert.equal(result.data.steamLinkAvailable, true);
    assert.equal(
      requests.some((url) => url.startsWith("/admin/api/member-verification?")),
      true,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadMentionProtectionRoute loads retained configuration and setup checks for a Free Guild", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const retained: MentionProtectionConfig = createDefaultMentionProtectionConfig("guild-1", 1);
  retained.adminEnabled = true;
  retained.protectedAdminRoleIds = ["admin-role"];
  retained.adminRepeatResponse = {
    reply: true,
    delete: true,
    restriction: { type: "timeout", durationMs: 600_000 },
  };
  const checks = [
    {
      id: "mention-protection-retained-config",
      label: "Retained configuration",
      status: "warning" as const,
      detail: "Paid restrictions are dormant on Free.",
    },
  ];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "https://example.test");
    requests.push(url.pathname);
    if (url.pathname === "/admin/api/entitlement") {
      const limits = getGuildEntitlementLimits("free");
      return Response.json({
        tier: "free",
        limits,
        supportInvite: null,
        r2Usage: {
          usedBytes: 0,
          reservedBytes: 0,
          maxBytes: limits.r2MaxBytes,
          lastReconciledAtMs: null,
        },
      });
    }
    if (url.pathname === "/admin/api/mention-protection") {
      return Response.json({ guildId: "guild-1", config: retained });
    }
    if (url.pathname === "/admin/api/permissions") {
      return Response.json({ guildId: "guild-1", feature: "mention-protection", checks });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as typeof fetch;

  try {
    const result = await loadMentionProtectionRoute({
      params: { guildId: "guild-1" },
      location: { searchStr: "?workspaceId=workspace-1" },
    });

    assert.equal(result.data.entitlement?.tier, "free");
    assert.deepEqual(result.data.config, retained);
    assert.deepEqual(result.data.setupChecks, checks);
    assert.deepEqual(
      [...new Set(requests)].sort(),
      ["/admin/api/entitlement", "/admin/api/mention-protection", "/admin/api/permissions"].sort(),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadEvidenceVaultRoute loads record usage and configuration for a Free Guild", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/admin/api/entitlement?")) {
      return Response.json({
        tier: "free",
        limits: {
          blocklistMaxEmojis: 10,
          reactionLimitsEnabled: true,
          ticketsMaxPanels: 1,
          ticketsMaxTypesPerPanel: 1,
          platformLinkMaxLinks: 100,
          managedMessagesMax: 3,
          clansMax: 5,
          clanMembersMax: 25,
          clanOfficersMax: 5,
          messageTemplatesMax: 3,
          evidenceVaultMaxRecords: 30,
          r2MaxBytes: 104857600,
          paidFeatures: false,
        },
        supportInvite: null,
        r2Usage: { usedBytes: 0, reservedBytes: 0, maxBytes: 104857600, lastReconciledAtMs: null },
      });
    }
    if (url.startsWith("/admin/api/evidence-vault?")) {
      return Response.json({
        guildId: "guild-1",
        config: null,
        enumValueUsage: {},
        recordUsage: { used: 27, max: 30 },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const result = await loadEvidenceVaultRoute({
      params: { guildId: "guild-1" },
      location: { searchStr: "?workspaceId=workspace-1" },
    });

    assert.equal(result.data.entitlement?.tier, "free");
    assert.deepEqual(result.data.recordUsage, { used: 27, max: 30 });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadPlayerLinkRoute reads Steam config from the provider-neutral endpoint", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];

  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    assert.match(url, /^\/admin\/api\/player-link\?/);

    return new Response(
      JSON.stringify({
        guildId: "guild-1",
        platform: "steam",
        config: {
          guildId: "guild-1",
          platform: "steam",
          linkedRoleId: null,
          logChannelId: null,
          gameAppIds: [],
          panelTitle: "Link Steam",
          panelDescription: "Link your Steam account.",
          panelButtonLabel: "Link Steam",
          panelButtonStyle: "Primary",
          allowRelink: true,
          allowMultipleLinks: false,
          requireRelinkOnRejoin: false,
          whoisFields: [],
          customLinks: [{ label: "CFTools", url: "https://example.com/{steamId64}" }],
          panelChannelId: null,
          panelMessageId: null,
          updatedAtMs: 1,
        },
        links: [],
      }),
      { headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;

  try {
    const result = await loadPlayerLinkRoute({
      params: { guildId: "guild-1" },
      location: { searchStr: "?workspaceId=workspace-1&platform=steam" },
      deps: { platform: "steam" },
    });

    assert.deepEqual(requests, [
      "/admin/api/player-link?guildId=guild-1&workspaceId=workspace-1&platform=steam",
    ]);
    assert.deepEqual(result.data.config?.customLinks, [
      { label: "CFTools", url: "https://example.com/{steamId64}" },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("loadManagedMessagesRoute owns the page's initial Guild resources", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  resetGuildResourcesCache();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/admin/api/managed-messages/resources?")) {
      return Response.json({
        guildId: "guild-1",
        roles: [{ id: "role-1", name: "Announcements" }],
        categories: [],
        textChannels: [{ id: "channel-1", name: "rules" }],
        voiceChannels: [],
        stageChannels: [],
        forumChannels: [],
      });
    }
    if (url.startsWith("/admin/api/managed-messages/capabilities?")) {
      return Response.json({ canWrite: true });
    }
    if (url.startsWith("/admin/api/entitlement?")) {
      return Response.json({
        tier: "free",
        limits: { managedMessagesMax: 3 },
        supportInvite: null,
        r2Usage: { usedBytes: 0, maxBytes: 0 },
      });
    }
    if (url.startsWith("/admin/api/managed-messages?")) {
      return Response.json({ guildId: "guild-1", messages: [], drafts: [] });
    }
    if (url.startsWith("/admin/api/message-templates?")) {
      return Response.json({ guildId: "guild-1", templates: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const result = await loadManagedMessagesRoute({
      params: { guildId: "guild-1" },
      location: { searchStr: "?workspaceId=workspace-1" },
    });

    assert.deepEqual(result.data.resources.textChannels, [{ id: "channel-1", name: "rules" }]);
    assert.deepEqual(result.data.resources.roles, [{ id: "role-1", name: "Announcements" }]);
    assert.equal(result.data.canWrite, true);
    assert.equal(requests.length, 5);
    assert.deepEqual(
      requests
        .map((request) => new URL(request, "https://example.test"))
        .map((url) => {
          assert.equal(url.searchParams.get("workspaceId"), "workspace-1");
          assert.equal(url.searchParams.get("guildId"), "guild-1");
          return url.pathname;
        })
        .sort(),
      [
        "/admin/api/entitlement",
        "/admin/api/managed-messages",
        "/admin/api/managed-messages/capabilities",
        "/admin/api/managed-messages/resources",
        "/admin/api/message-templates",
      ],
    );
  } finally {
    globalThis.fetch = originalFetch;
    resetGuildResourcesCache();
  }
});

test("loadManagedMessagesRoute loads Premium Plus entitlement without a workspace", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const limits = getGuildEntitlementLimits("premium_plus");
  resetGuildResourcesCache();
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith("/admin/api/entitlement?")) {
      return Response.json({
        tier: "premium_plus",
        limits,
        supportInvite: null,
        r2Usage: {
          usedBytes: 0,
          reservedBytes: 0,
          maxBytes: limits.r2MaxBytes,
          lastReconciledAtMs: null,
        },
      });
    }
    if (url.startsWith("/admin/api/managed-messages/resources?")) {
      return Response.json({
        guildId: "guild-1",
        roles: [],
        categories: [],
        textChannels: [],
        voiceChannels: [],
        stageChannels: [],
        forumChannels: [],
      });
    }
    if (url.startsWith("/admin/api/managed-messages/capabilities?")) {
      return Response.json({ canWrite: true });
    }
    if (url.startsWith("/admin/api/managed-messages?")) {
      return Response.json({ guildId: "guild-1", messages: [], drafts: [] });
    }
    if (url.startsWith("/admin/api/message-templates?")) {
      return Response.json({ guildId: "guild-1", templates: [] });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    const result = await loadManagedMessagesRoute({
      params: { guildId: "guild-1" },
      location: { searchStr: "" },
    });

    assert.equal(result.data.entitlement?.tier, "premium_plus");
    assert.equal(result.data.entitlement?.limits.managedMessagesMax, null);
    assert.equal(requests.includes("/admin/api/entitlement?guildId=guild-1"), true);
  } finally {
    globalThis.fetch = originalFetch;
    resetGuildResourcesCache();
  }
});
