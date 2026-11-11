/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import type { MarketplaceConfig } from "../src/types";
import type { RuntimeStores, DiscordInteraction } from "../src/runtime/app-types";
import { MarketplaceService } from "../src/services/marketplace-service";
import {
  handleMarketplaceComponentInteraction,
  handleMarketplaceModalSubmitInteraction,
} from "../src/runtime/marketplace-interaction-handler";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

const config: MarketplaceConfig = {
  guildId: "guild-1",
  noticeChannelId: "noticeboard",
  noticeMessageId: null,
  logChannelId: null,
  serverChoiceEnabled: false,
  serverOptions: [],
  additionalChoicesEnabled: true,
  additionalChoices: [
    {
      id: "listing-type",
      label: "Choose a listing type",
      options: [
        { id: "weapon", label: "Weapon", emoji: null },
        { id: "vehicle", label: "Vehicle", emoji: null },
      ],
    },
    {
      id: "condition",
      label: "Choose its condition",
      options: [
        { id: "new", label: "New", emoji: null },
        { id: "used", label: "Used", emoji: null },
      ],
    },
  ],
  updatedAtMs: 42,
};

test("marketplace interaction skips disabled server choice and continues through additional choices", async () => {
  const service = {
    async getConfig() {
      return config;
    },
  } as unknown as MarketplaceService;
  const stores = { marketplace: {} } as RuntimeStores;

  const choiceResponse = await handleMarketplaceComponentInteraction(
    interaction("market:type:have"),
    stores,
    service,
  );
  const choiceBody = (await choiceResponse.json()) as {
    type: number;
    data: { content: string; components: Array<{ components: Array<{ custom_id: string }> }> };
  };

  assert.equal(choiceBody.type, 7);
  assert.equal(choiceBody.data.content, "Choose a listing type");
  assert.equal(
    choiceBody.data.components[0].components[1].custom_id,
    "market:choice:have:~:0:1:~:16",
  );

  const secondChoiceResponse = await handleMarketplaceComponentInteraction(
    interaction("market:choice:have:~:0:1:~:16"),
    stores,
    service,
  );
  const secondChoiceBody = (await secondChoiceResponse.json()) as {
    data: { content: string; components: Array<{ components: Array<{ custom_id: string }> }> };
  };
  assert.equal(secondChoiceBody.data.content, "Choose its condition");
  assert.equal(
    secondChoiceBody.data.components[0].components[1].custom_id,
    "market:choice:have:~:1:1:1:16",
  );

  const modalResponse = await handleMarketplaceComponentInteraction(
    interaction("market:choice:have:~:1:1:1:16"),
    stores,
    service,
  );
  const modalBody = (await modalResponse.json()) as { type: number; data: { custom_id: string } };

  assert.equal(modalBody.type, 9);
  assert.equal(modalBody.data.custom_id, "market:modal:have:~:16:1,1");
});

test("marketplace interaction puts additional choices after an enabled server choice", async () => {
  const service = {
    async getConfig() {
      return {
        ...config,
        serverChoiceEnabled: true,
        serverOptions: [{ id: "namalsk", label: "Namalsk", emoji: null }],
      };
    },
  } as unknown as MarketplaceService;
  const stores = { marketplace: {} } as RuntimeStores;

  const serverResponse = await handleMarketplaceComponentInteraction(
    interaction("market:type:want"),
    stores,
    service,
  );
  const serverBody = (await serverResponse.json()) as {
    data: { components: Array<{ components: Array<{ custom_id: string }> }> };
  };
  assert.equal(
    serverBody.data.components[0].components[0].custom_id,
    "market:server:want:namalsk:16",
  );

  const choiceResponse = await handleMarketplaceComponentInteraction(
    interaction("market:server:want:namalsk:16"),
    stores,
    service,
  );
  const choiceBody = (await choiceResponse.json()) as { data: { content: string } };
  assert.equal(choiceBody.data.content, "Choose a listing type");
});

function interaction(customId: string): DiscordInteraction {
  return {
    type: 3,
    guild_id: "guild-1",
    channel_id: "channel-1",
    member: { user: { id: "user-1", username: "User" } },
    data: { custom_id: customId },
  };
}

for (const messageId of ["published-message", ""]) {
  test(`marketplace creation ${messageId ? "links to its published post" : "omits the link without a message target"}`, async () => {
    const fixture = createProductionRuntimeStores();
    try {
      await fixture.stores.marketplace.upsertMarketplaceConfig({
        ...config,
        additionalChoicesEnabled: false,
      });
      const service = new MarketplaceService(fixture.stores.marketplace, {
        async createChannelMessage(channelId) {
          return { id: messageId, channel_id: channelId, content: "" };
        },
        async editChannelMessage(channelId, id) {
          return { id, channel_id: channelId, content: "" };
        },
        async deleteChannelMessage() {},
        async createUserDmMessage() {
          return { id: "dm-message", channel_id: "dm-channel", content: "" };
        },
      });
      const response = await handleMarketplaceModalSubmitInteraction(
        { ...interaction("market:modal:have:~"), type: 5 },
        service,
      );
      const post = await fixture.stores.marketplace.readActiveMarketplacePostByOwner(
        "guild-1",
        "user-1",
      );
      assert.equal(post?.messageId, messageId);
      assert.deepEqual(await response.json(), {
        type: 4,
        data: {
          flags: 64,
          content:
            "Marketplace post created." +
            (messageId
              ? "\n\n[View post](https://discord.com/channels/guild-1/channel-1/published-message)"
              : ""),
        },
      });
    } finally {
      fixture.close();
    }
  });
}

test("disabled Marketplace rejects stale creation steps and modal submissions", async () => {
  const fixture = createProductionRuntimeStores();
  try {
    await fixture.stores.marketplace.upsertMarketplaceConfig(config);
    const service = new MarketplaceService(fixture.stores.marketplace, {
      async createChannelMessage() {
        throw new Error("Unexpected message");
      },
      async editChannelMessage() {
        throw new Error("Unexpected edit");
      },
      async deleteChannelMessage() {
        throw new Error("Unexpected delete");
      },
      async createUserDmMessage() {
        throw new Error("Unexpected DM");
      },
    });
    await service.disable("guild-1");
    for (const id of [
      "market:create",
      "market:type:have",
      "market:server:want:namalsk:16",
      "market:choice:have:~:0:1:~:16",
    ]) {
      const response = await handleMarketplaceComponentInteraction(
        interaction(id),
        fixture.stores,
        service,
      );
      assert.equal(
        ((await response.json()) as { data: { content: string } }).data.content,
        "Marketplace is disabled in this server.",
      );
    }
    const response = await handleMarketplaceModalSubmitInteraction(
      { ...interaction("market:modal:have:~"), type: 5 },
      service,
    );
    assert.equal(
      ((await response.json()) as { data: { content: string } }).data.content,
      "Marketplace is disabled in this server.",
    );
    assert.deepEqual(await service.listPosts("guild-1"), []);
  } finally {
    fixture.close();
  }
});
