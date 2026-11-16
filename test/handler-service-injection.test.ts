/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { buildEphemeralMessage } from "../src/discord-interactions";
import type { DiscordInteraction, RuntimeStores } from "../src/runtime/app-types";
import { handleApplicationCommand } from "../src/runtime/application-command-handler";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import type {
  ApplicationCommandServices,
  InteractionServices,
} from "../src/runtime/handler-services";
import { handleInteractionRequest } from "../src/runtime/interaction-handler";
import type { LfgConfig, MarketplaceConfig } from "../src/types";
import { applicationCommandServices, interactionServices } from "./support/handler-services";

type InteractionRequestOptions = Parameters<typeof handleInteractionRequest>[1];

const GUILD_ID = "guild-1";
const USER_ID = "owner-1";

function timestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

function signedRequest(interaction: unknown, signatureTimestamp = timestamp()): Request {
  return new Request("https://runtime.example/interactions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-signature-ed25519": "synthetic-signature",
      "x-signature-timestamp": signatureTimestamp,
    },
    body: JSON.stringify(interaction),
  });
}

/**
 * A store graph that only exposes the entries the exercised path legitimately
 * needs. Reading anything else fails, so a request-time fallback graph cannot
 * hide behind the injected services under test.
 */
function restrictedStores(allowed: Record<string, unknown>): RuntimeStores {
  return new Proxy(allowed, {
    get(target, property, receiver) {
      if (Reflect.has(target, property)) {
        return Reflect.get(target, property, receiver);
      }
      throw new Error(
        `Unexpected store access ${String(property)}; handlers must use injected services rather than rebuilding a graph.`,
      );
    },
  }) as unknown as RuntimeStores;
}

function verifiedOptions(
  overrides: Partial<InteractionRequestOptions> & Pick<InteractionRequestOptions, "services">,
): InteractionRequestOptions {
  return {
    discordPublicKey: "synthetic-public-key",
    discordBotToken: "synthetic-bot-token",
    stores: restrictedStores({}),
    gateway: { async start() {}, async status() {} } as never,
    verifyDiscordRequest: async () => true,
    ...overrides,
  };
}

const LFG_CONFIG: LfgConfig = {
  guildId: GUILD_ID,
  enabled: true,
  noticeChannelId: "noticeboard",
  noticeMessageId: null,
  notificationRoleId: null,
  counterVoiceChannelId: null,
  counterDisplayFormat: "{count}",
  approvalFlowEnabled: false,
  approvalAuditChannelId: null,
  approvalVoiceCategoryId: null,
  expiryAction: "close",
  expiryDurationHours: 24,
  serverOptions: [],
  updatedAtMs: 1,
};

const MARKETPLACE_CONFIG: MarketplaceConfig = {
  guildId: GUILD_ID,
  noticeChannelId: "noticeboard",
  noticeMessageId: null,
  logChannelId: null,
  serverChoiceEnabled: true,
  serverOptions: [{ id: "namalsk", label: "Namalsk", emoji: null }],
  additionalChoicesEnabled: false,
  additionalChoices: [],
  updatedAtMs: 1,
};

test("repeated LFG dispatches call the injected service without rebuilding the graph", async () => {
  const configReads: string[] = [];
  const activePostLookups: string[] = [];
  const lfgService = {
    async getConfig(guildId: string) {
      configReads.push(guildId);
      return LFG_CONFIG;
    },
  } as unknown as InteractionServices["lfgService"];
  const stores = restrictedStores({
    lfg: {
      async readActiveLfgPostByOwner(guildId: string, userId: string) {
        activePostLookups.push(`${guildId}:${userId}`);
        return null;
      },
    },
  });
  const options = verifiedOptions({
    stores,
    services: interactionServices({ lfgService }),
    features: ALL_FEATURES_ENABLED,
  });
  const interaction = {
    type: 3,
    guild_id: GUILD_ID,
    channel_id: "noticeboard",
    member: { user: { id: USER_ID } },
    data: { custom_id: "lfg:create" },
  };

  const responses: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await handleInteractionRequest(signedRequest(interaction), options);
    assert.equal(response.status, 200);
    responses.push(await response.json());
  }

  assert.deepEqual(responses[0], responses[1]);
  assert.deepEqual(responses[0], {
    type: 4,
    data: {
      flags: 64,
      content: "Choose which server your LFG post is for.",
      components: [],
    },
  });
  assert.deepEqual(configReads, [GUILD_ID, GUILD_ID, GUILD_ID, GUILD_ID]);
  assert.deepEqual(activePostLookups, [`${GUILD_ID}:${USER_ID}`, `${GUILD_ID}:${USER_ID}`]);
});

test("repeated Marketplace dispatches call the injected service without touching stores", async () => {
  const configReads: string[] = [];
  const marketplaceService = {
    async getConfig(guildId: string) {
      configReads.push(guildId);
      return MARKETPLACE_CONFIG;
    },
  } as unknown as InteractionServices["marketplaceService"];
  const options = verifiedOptions({
    stores: restrictedStores({}),
    services: interactionServices({ marketplaceService }),
    features: ALL_FEATURES_ENABLED,
  });
  const interaction = {
    type: 3,
    guild_id: GUILD_ID,
    channel_id: "noticeboard",
    member: { user: { id: USER_ID } },
    data: { custom_id: "market:type:have" },
  };

  const responses: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await handleInteractionRequest(signedRequest(interaction), options);
    assert.equal(response.status, 200);
    responses.push(await response.json());
  }

  assert.deepEqual(responses[0], responses[1]);
  assert.equal(
    (responses[0] as { data: { content: string } }).data.content,
    "Which server is this for?",
  );
  assert.deepEqual(configReads, [GUILD_ID, GUILD_ID, GUILD_ID, GUILD_ID]);
});

test("repeated application commands call the injected service without rebuilding the graph", async () => {
  const listCalls: string[] = [];
  const timedRoleService = {
    async listTimedRoles(guildId: string) {
      listCalls.push(guildId);
      return [];
    },
  } as unknown as ApplicationCommandServices["timedRoleService"];
  const stores = restrictedStores({ whiteLabelBots: undefined, guildRbac: undefined });
  const interaction: DiscordInteraction = {
    type: 2,
    guild_id: GUILD_ID,
    member: { permissions: "8", user: { id: "staff-1" } },
    data: { name: "timedrole", options: [{ type: 1, name: "list" }] },
  };
  const options = {
    services: applicationCommandServices({ timedRoleService }),
  };

  const responses: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await handleApplicationCommand(
      interaction,
      stores,
      "synthetic-bot-token",
      ALL_FEATURES_ENABLED,
      options,
    );
    assert.equal(response.status, 200);
    responses.push(await response.json());
  }

  assert.deepEqual(responses[0], responses[1]);
  assert.deepEqual(
    responses[0],
    buildEphemeralMessage("No timed roles are active in this server."),
  );
  assert.deepEqual(listCalls, [GUILD_ID, GUILD_ID]);
});

test("unauthenticated and stale requests reject before reading the service or store graph", async () => {
  const cases = [
    {
      name: "missing signature",
      request: () =>
        new Request("https://runtime.example/interactions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ type: 1 }),
        }),
      verify: async () => true,
    },
    {
      name: "invalid signature",
      request: () => signedRequest({ type: 1 }),
      verify: async () => false,
    },
    {
      name: "stale timestamp",
      request: () => signedRequest({ type: 1 }, "1"),
      verify: async () => true,
    },
  ] as const;

  for (const current of cases) {
    let storeReads = 0;
    let serviceReads = 0;
    const stores = new Proxy(
      {},
      {
        get() {
          storeReads += 1;
          throw new Error("Store graph must not be read before authentication.");
        },
      },
    ) as unknown as RuntimeStores;
    const options = {
      discordPublicKey: "synthetic-public-key",
      discordBotToken: "synthetic-bot-token",
      stores,
      gateway: { async start() {}, async status() {} } as never,
      verifyDiscordRequest: current.verify,
      get services(): InteractionRequestOptions["services"] {
        serviceReads += 1;
        throw new Error("Service graph must not be read before authentication.");
      },
    } as unknown as InteractionRequestOptions;

    const response = await handleInteractionRequest(current.request(), options);
    assert.equal(response.status, 401, current.name);
    assert.equal(storeReads, 0, `${current.name} must not read stores`);
    assert.equal(serviceReads, 0, `${current.name} must not read services`);
  }
});

test("invalid interaction content rejects without reading service dependencies", async () => {
  let storeReads = 0;
  let serviceReads = 0;
  const stores = new Proxy(
    {},
    {
      get() {
        storeReads += 1;
        throw new Error("Store graph must not be read for an invalid interaction.");
      },
    },
  ) as unknown as RuntimeStores;
  const services = new Proxy(
    {},
    {
      get() {
        serviceReads += 1;
        throw new Error("Service graph must not be read for an invalid interaction.");
      },
    },
  ) as unknown as InteractionRequestOptions["services"];
  const options = verifiedOptions({ stores, services });

  const response = await handleInteractionRequest(
    signedRequest({ type: 5, member: { user: { id: USER_ID } } }),
    options,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("This interaction can only be used inside a server."),
  );
  assert.equal(storeReads, 0);
  assert.equal(serviceReads, 0);
});
