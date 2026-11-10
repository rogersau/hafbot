/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import { createDefaultMarketplaceConfig } from "../src/marketplace-config";
import type { RuntimeStores } from "../src/runtime/app-types";
import { createServiceFactory } from "../src/runtime/service-factory";

function createStores(): RuntimeStores {
  return {
    marketplace: {
      async readMarketplaceConfig() {
        return null;
      },
      async upsertMarketplaceConfig() {},
    },
  } as unknown as RuntimeStores;
}

test("service factory coalesces concurrent Guild validation loads without reusing settled results", async () => {
  const originalFetch = globalThis.fetch;
  let channelRequests = 0;
  let roleRequests = 0;
  let channelAvailable = true;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/channels")) {
      channelRequests += 1;
      return Response.json(
        channelAvailable
          ? [
              {
                id: "channel-1",
                guild_id: "guild-resource-cache",
                name: "general",
                type: 0,
                parent_id: null,
                position: 0,
              },
            ]
          : [],
      );
    }
    if (url.endsWith("/roles")) {
      roleRequests += 1;
      return Response.json([]);
    }
    throw new Error(`Unexpected Discord request: ${url}`);
  };

  try {
    const firstServices = createServiceFactory({
      stores: createStores(),
      discordBotToken: "resource-cache-token",
    });
    const secondServices = createServiceFactory({
      stores: createStores(),
      discordBotToken: "resource-cache-token",
    });
    const config = {
      ...createDefaultMarketplaceConfig("guild-resource-cache"),
      noticeChannelId: "channel-1",
    };

    await Promise.all([
      firstServices.marketplaceService.updateConfig(config),
      secondServices.marketplaceService.updateConfig(config),
    ]);
    channelAvailable = false;
    await assert.rejects(
      createServiceFactory({
        stores: createStores(),
        discordBotToken: "resource-cache-token",
      }).marketplaceService.updateConfig(config),
      /Invalid Discord resource/,
    );

    assert.equal(channelRequests, 2);
    assert.equal(roleRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("service factory does not cache a rejected Guild resource validation load", async () => {
  const originalFetch = globalThis.fetch;
  let channelRequests = 0;
  let roleRequests = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/channels")) {
      channelRequests += 1;
      if (channelRequests === 1) return new Response("unavailable", { status: 500 });
      return Response.json([
        {
          id: "channel-1",
          guild_id: "guild-resource-recovery",
          name: "general",
          type: 0,
          parent_id: null,
          position: 0,
        },
      ]);
    }
    if (url.endsWith("/roles")) {
      roleRequests += 1;
      return Response.json([]);
    }
    throw new Error(`Unexpected Discord request: ${url}`);
  };

  try {
    const services = createServiceFactory({
      stores: createStores(),
      discordBotToken: "resource-recovery-token",
    });
    const config = {
      ...createDefaultMarketplaceConfig("guild-resource-recovery"),
      noticeChannelId: "channel-1",
    };

    await assert.rejects(
      services.marketplaceService.updateConfig(config),
      /Discord API error: 500/,
    );
    await services.marketplaceService.updateConfig(config);

    assert.equal(channelRequests, 2);
    assert.equal(roleRequests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
