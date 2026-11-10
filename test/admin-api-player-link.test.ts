/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createAdminApiHandler } from "./helpers/admin-api";
import { createPermissiveGuildResourceValidator } from "./helpers/guild-resource-validator";
import {
  createMemoryOperationalIncidentStore,
  OperationalIncidentService,
} from "../src/operations/incidents";
import {
  createProductionRuntimeStores,
  type ProductionRuntimeStoresFixture,
} from "./support/production-runtime-stores";

const fixtures = new Set<ProductionRuntimeStoresFixture>();
test.after(() => {
  for (const fixture of fixtures) fixture.close();
  fixtures.clear();
});

test("Player Link panel permission failures are audited and shown as an operational incident", async () => {
  const fixture = createProductionRuntimeStores();
  fixtures.add(fixture);
  await fixture.stores.platformLink.upsertPlatformLinkConfig({
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
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: 1,
  });
  await fixture.stores.guildAuditLog.upsertConfig({
    guildId: "guild-1",
    auditChannelId: "audit-channel",
    groupChannelIds: {},
    eventStates: { groups: { "platform-link": true }, overrides: {} },
    excludedChannelIds: [],
    excludedRoleIds: [],
    updatedAtMs: 1,
  });

  const incidents = new OperationalIncidentService(createMemoryOperationalIncidentStore());
  const handler = createAdminApiHandler({
    stores: fixture.stores,
    discordBotToken: "token",
    guildResources: createPermissiveGuildResourceValidator(),
    services: { operationalIncidentService: incidents },
  });
  const auditBodies: Array<{ embeds: Array<{ title: string; fields: Array<{ value: string }> }> }> =
    [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/channels/blocked-panel/messages")) {
      return new Response(JSON.stringify({ message: "Missing Permissions", code: 50013 }), {
        status: 403,
      });
    }
    if (url.includes("/channels/audit-channel/messages")) {
      auditBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "audit-message" });
    }
    throw new Error(`Unexpected Discord request: ${url}`);
  };

  try {
    const failed = await publish(handler, "blocked-panel");
    assert.equal(failed.status, 403);
    assert.equal(((await failed.json()) as { code: string }).code, "permission_denied");
    assert.equal(auditBodies.length, 1);
    assert.equal(auditBodies[0]?.embeds[0]?.title, "Play Link Panel Publish Failed");
    assert.equal(JSON.stringify(auditBodies).includes("Missing Permissions"), false);

    const [incident] = await incidents.list({ guildId: "guild-1" });
    assert.equal(incident?.summaryCode, "platform_link_panel_publish_permission_denied");
    assert.equal(incident?.deepLink.startsWith("/admin/guild-1/player-link?incidentId="), true);

    globalThis.fetch = async () => Response.json({ id: "panel-message" });
    const published = await publish(handler, "replacement-panel");
    assert.equal(published.status, 200);
    assert.deepEqual(await incidents.list({ guildId: "guild-1" }), []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function publish(
  handler: ReturnType<typeof createAdminApiHandler>,
  panelChannelId: string,
): Promise<Response> {
  return handler(
    new Request("https://example.com/admin/api/player-link/publish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        platform: "steam",
        panelChannelId,
      }),
    }),
    new URL("https://example.com/admin/api/player-link/publish"),
  ) as Promise<Response>;
}
