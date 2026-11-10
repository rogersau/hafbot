/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { createClanAdminRoutes } from "../src/runtime/admin-routes/clans";
import type { RuntimeStores } from "../src/runtime/app-types";
import type { ClanService } from "../src/services/clan-service";

test("Clan Admin review derives its actor and authority from the authenticated route", async () => {
  let received: Record<string, unknown> | null = null;
  const service = {
    async reviewRequest(input: Record<string, unknown>) {
      received = input;
      return { id: "request-1" };
    },
  } as unknown as ClanService;
  const routes = createClanAdminRoutes({
    stores: { clans: {} } as RuntimeStores,
    service,
    readCustomerAdminSession: async () => ({
      user: {
        id: "account-1",
        discordUserId: "discord-admin-1",
        name: "Admin",
      },
    }),
  });
  const route = routes.find((candidate) => candidate.path.endsWith("/requests/review"));
  assert.ok(route);
  await route.handler({
    request: new Request("https://example.test/admin/api/clans/requests/review"),
    url: new URL("https://example.test/admin/api/clans/requests/review"),
    params: {},
    query: undefined,
    body: {
      guildId: "guild-1",
      requestId: "request-1",
      expectedRevision: 1,
      decision: "approve",
    },
  });
  const captured = received as Record<string, unknown> | null;
  assert.ok(captured);
  assert.equal(captured.reviewerId, "discord-admin-1");
  assert.equal(captured.isGuildAdmin, true);
  assert.deepEqual(captured.reviewerRoleIds, []);
});

test("Clan Admin config schema strips HAF-owned resource identifiers", () => {
  const routes = createClanAdminRoutes({ stores: { clans: {} } as RuntimeStores });
  const route = routes.find((candidate) => candidate.path.endsWith("/clans/config"));
  assert.ok(route?.body);
  const parsed = route.body.parse({
    guildId: "guild-1",
    enabled: true,
    reviewerRoleIds: [],
    staffAccessRoleIds: [],
    eligibilityAllowedRoleIds: [],
    eligibilityRequiredRoleIds: [],
    minimumAccountAgeDays: 0,
    minimumGuildTenureDays: 0,
    requestCooldownDays: 7,
    invitationExpiryDays: 7,
    applicationExpiryDays: 7,
    localClansMax: null,
    localMembersMax: null,
    localOfficersMax: null,
    categoryId: "external-category",
    requestPanelChannelId: "external-channel",
    requestReviewCategoryId: "review-category",
    requestPanelTitle: "Create a Clan",
    requestPanelDescription: "Apply here",
    requestPanelButtonLabel: "Create Clan",
    requestPanelColor: 0x5865f2,
    requestPanelMessageId: "external-message",
    boardEnabled: false,
    boardChannelId: null,
    boardChannelType: null,
    roleNameTemplate: "[{tag}] {name}",
    textChannelNameTemplate: "{tag}-chat",
    voiceChannelNameTemplate: "{tag} Voice",
    inactivityEnabled: false,
    inactivityWarningDays: 60,
    inactivityArchiveDays: 90,
    publicLfgAttributionEnabled: true,
  }) as Record<string, unknown>;
  assert.equal("categoryId" in parsed, false);
  assert.equal("requestPanelChannelId" in parsed, false);
  assert.equal("requestReviewCategoryId" in parsed, false);
  assert.equal("requestPanelMessageId" in parsed, false);
});
