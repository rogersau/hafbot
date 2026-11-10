/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
import test from "node:test";

import {
  createGuildFeaturesAdminRoutes,
  type GuildFeaturesAdminRoutesOptions,
} from "../src/runtime/admin-routes/guild-features";
import {
  MemberVerificationService,
  type MemberVerificationAdminSnapshot,
  type RepairMemberVerificationWelcomePanelResult,
  type SaveMemberVerificationAdminConfigInput,
  type SaveMemberVerificationAdminConfigResult,
} from "../src/services/member-verification-service";
import type { MemberVerificationConfig } from "../src/types";
import {
  createProductionRuntimeStores,
  type ProductionRuntimeStoresFixture,
} from "./support/production-runtime-stores";
import { createPermissiveGuildResourceValidator } from "./helpers/guild-resource-validator";

const fixtures = new Set<ProductionRuntimeStoresFixture>();
test.after(() => {
  for (const fixture of fixtures) fixture.close();
  fixtures.clear();
});

function config(overrides: Partial<MemberVerificationConfig> = {}): MemberVerificationConfig {
  return {
    guildId: "guild-1",
    enabled: true,
    verifiedRoleId: "role-1",
    title: "Welcome",
    description: "Click Verify below.",
    color: 0x5865f2,
    imageUrl: null,
    thumbnailUrl: null,
    rulesUrl: null,
    verifyButtonEmoji: null,
    deliveryMode: "channel",
    verificationMethod: "discord-button",
    welcomeChannelId: "channel-1",
    panelMessageId: "panel-1",
    updatedAtMs: 1,
    ...overrides,
  };
}

function moduleStub(
  overrides: {
    snapshot?: MemberVerificationAdminSnapshot;
    saveResult?: SaveMemberVerificationAdminConfigResult;
    repairResult?: RepairMemberVerificationWelcomePanelResult;
    onSave?: (input: SaveMemberVerificationAdminConfigInput) => void;
  } = {},
): MemberVerificationService {
  const snapshot =
    overrides.snapshot ??
    ({
      guildId: "guild-1",
      config: null,
      paidMethodsAvailable: true,
      turnstileAvailable: false,
      steamLinkAvailable: true,
      steamLinkConfigured: false,
    } satisfies MemberVerificationAdminSnapshot);
  return {
    readAdminSnapshot: async () => snapshot,
    saveAdminConfig: async (input: SaveMemberVerificationAdminConfigInput) => {
      overrides.onSave?.(input);
      return (
        overrides.saveResult ?? {
          outcome: "saved",
          config: config(),
          panelOutcome: "refreshed",
        }
      );
    },
    repairWelcomePanel: async () =>
      overrides.repairResult ?? { outcome: "refreshed", panelMessageId: "panel-1" },
  } as unknown as MemberVerificationService;
}

function routesFor(
  fixture: ProductionRuntimeStoresFixture,
  memberVerificationService: MemberVerificationService,
  overrides: Partial<GuildFeaturesAdminRoutesOptions> = {},
) {
  return createGuildFeaturesAdminRoutes({
    stores: fixture.stores,
    adminAccess: {} as never,
    discordBotToken: "bot-token",
    guildResources: createPermissiveGuildResourceValidator(),
    memberVerificationService,
    ...overrides,
  });
}

test("Member Verification GET forwards the module administrator snapshot", async () => {
  const fixture = createProductionRuntimeStores();
  fixtures.add(fixture);
  const snapshot: MemberVerificationAdminSnapshot = {
    guildId: "guild-1",
    config: config({ verificationMethod: "steam-link" }),
    paidMethodsAvailable: false,
    turnstileAvailable: true,
    steamLinkAvailable: true,
    steamLinkConfigured: true,
  };
  const route = routesFor(fixture, moduleStub({ snapshot })).find(
    (entry) => entry.method === "GET" && entry.path === "/admin/api/member-verification",
  );
  assert.ok(route);

  const response = await route.handler({
    request: new Request("https://admin.example/admin/api/member-verification?guildId=guild-1"),
    url: new URL("https://admin.example/admin/api/member-verification?guildId=guild-1"),
    params: {},
    query: { guildId: "guild-1" },
    body: undefined,
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), snapshot);
});

test("Member Verification save translates panel repair required without losing saved config", async () => {
  const fixture = createProductionRuntimeStores();
  fixtures.add(fixture);
  const savedConfig = config({ panelMessageId: null });
  let received: SaveMemberVerificationAdminConfigInput | undefined;
  const route = routesFor(
    fixture,
    moduleStub({
      saveResult: { outcome: "saved-panel-repair-required", config: savedConfig },
      onSave: (input) => {
        received = input;
      },
    }),
    {
      readCustomerAdminSession: async () => ({
        user: { id: "session-1", discordUserId: "admin-1", name: "Admin" },
      }),
    },
  ).find(
    (entry) => entry.method === "POST" && entry.path === "/admin/api/member-verification/config",
  );
  assert.ok(route);

  const response = await route.handler({
    request: new Request("https://admin.example/admin/api/member-verification/config", {
      method: "POST",
    }),
    url: new URL("https://admin.example/admin/api/member-verification/config"),
    params: {},
    query: undefined,
    body: {
      guildId: "guild-1",
      enabled: true,
      verifiedRoleId: "role-1",
      deliveryMode: "channel",
      welcomeChannelId: "channel-1",
    },
    adminRequest: {
      operationId: "operation-1",
      correlationId: "correlation-1",
      method: "POST",
      routePath: "/admin/api/member-verification/config",
      startedAtMs: 1,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    guildId: "guild-1",
    config: savedConfig,
    outcome: "saved-panel-repair-required",
  });
  assert.equal(received?.actor.actorUserId, "admin-1");
  assert.equal(received?.actor.operationId, "operation-1");
  assert.equal(received?.actor.correlationId, "correlation-1");
});

test("Member Verification save translates method prerequisites", async () => {
  const fixture = createProductionRuntimeStores();
  fixtures.add(fixture);
  const route = routesFor(
    fixture,
    moduleStub({
      saveResult: {
        outcome: "method-unavailable",
        reason: "steam-link-guild-config-missing",
      },
    }),
  ).find(
    (entry) => entry.method === "POST" && entry.path === "/admin/api/member-verification/config",
  );
  assert.ok(route);

  const response = await route.handler({
    request: new Request("https://admin.example/admin/api/member-verification/config", {
      method: "POST",
    }),
    url: new URL("https://admin.example/admin/api/member-verification/config"),
    params: {},
    query: undefined,
    body: {
      guildId: "guild-1",
      enabled: true,
      verifiedRoleId: "role-1",
      verificationMethod: "steam-link",
    },
  });

  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { error?: string }).error ?? "", /Configure Steam Link/);
});

test("Member Verification panel repair translates module success and failure", async () => {
  const fixture = createProductionRuntimeStores();
  fixtures.add(fixture);
  const successRoute = routesFor(
    fixture,
    moduleStub({ repairResult: { outcome: "created", panelMessageId: "panel-2" } }),
  ).find(
    (entry) =>
      entry.method === "POST" && entry.path === "/admin/api/member-verification/panel/publish",
  );
  const failureRoute = routesFor(fixture, moduleStub({ repairResult: { outcome: "failed" } })).find(
    (entry) =>
      entry.method === "POST" && entry.path === "/admin/api/member-verification/panel/publish",
  );
  assert.ok(successRoute);
  assert.ok(failureRoute);
  const request = {
    request: new Request("https://admin.example/admin/api/member-verification/panel/publish", {
      method: "POST",
    }),
    url: new URL("https://admin.example/admin/api/member-verification/panel/publish"),
    params: {},
    query: undefined,
    body: { guildId: "guild-1" },
  };

  const success = await successRoute.handler(request);
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), {
    guildId: "guild-1",
    panelMessageId: "panel-2",
    outcome: "created",
  });

  const failure = await failureRoute.handler(request);
  assert.equal(failure.status, 502);
});
