/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />
import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { DiscordApiError } from "../src/discord/client";
import type { DiscordInteraction } from "../src/runtime/app-types";
import type {
  PlatformLinkConfig,
  PlatformLinkPlatform,
} from "../src/runtime/contracts/platform-link-store";
import { handleSteamManualLinkCommand } from "../src/runtime/steam-link-interaction-handler";
import { handleXboxManualLinkCommand } from "../src/runtime/xbox-link-interaction-handler";
import {
  handlePlayStationLinkModalSubmit,
  handlePlayStationManualLinkCommand,
} from "../src/runtime/playstation-link-interaction-handler";
import { createPlatformLinkService } from "../src/services/platform-link-service";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

const cases = [
  {
    platform: "steam",
    field: "steamid",
    platformId: "76561198000000002",
    handler: handleSteamManualLinkCommand,
  },
  {
    platform: "xbox",
    field: "xuid",
    platformId: "1234567890123456",
    handler: handleXboxManualLinkCommand,
  },
  {
    platform: "playstation",
    field: "psn_id",
    platformId: "Player_Two",
    handler: handlePlayStationManualLinkCommand,
  },
  {
    platform: "playstation",
    field: "psn_online_id",
    platformId: "Player_Two",
    handler: handlePlayStationLinkModalSubmit,
  },
] satisfies Array<{
  platform: PlatformLinkPlatform;
  field: string;
  platformId: string;
  handler: typeof handleSteamManualLinkCommand;
}>;

for (const entry of cases) {
  for (const failure of [
    "precommit",
    "precommit-429",
    "finalization",
    "finalization-429",
    "role",
    "audit",
  ] as const) {
    test(`${entry.handler.name} handles ${failure} failure according to commit state`, async () => {
      const fixture = createProductionRuntimeStores();
      try {
        const store = fixture.stores.platformLink;
        await store.upsertPlatformLinkConfig(config(entry.platform));
        await store.upsertPlatformLink({
          guildId: "guild-1",
          userId: "user-1",
          platform: entry.platform,
          platformId: "original",
          linkedAtMs: 1,
          manual: true,
          actionedByUserId: null,
          metadataJson: null,
          active: true,
        });
        const saveError = failure.endsWith("-429")
          ? new DiscordApiError("membership rate limited", 429, "retry later")
          : new Error("finalization unavailable");
        const service = createPlatformLinkService({
          platformLinkStore: store,
          discordBotToken: "test-token",
          onLinksReplacing: async (_link, replaceLinks) => {
            if (failure.startsWith("precommit")) throw saveError;
            await replaceLinks();
            if (failure.startsWith("finalization")) throw saveError;
          },
        });
        const effects: string[] = [];
        service.assignLinkedRole = async () => {
          effects.push("role");
          if (failure === "role") throw new Error("role unavailable");
        };
        service.sendLogEmbed = async () => {
          effects.push("audit");
          if (failure === "audit") throw new Error("audit unavailable");
        };
        if (failure.startsWith("precommit")) {
          await assert.rejects(
            entry.handler(interaction(entry.field, entry.platformId), service),
            (error: unknown) => error === saveError,
          );
          assert.deepEqual(effects, []);
          const saved = await service.getLinksByUser("guild-1", "user-1");
          assert.equal(saved.length, 1);
          assert.equal(saved[0]?.platformId, "original");
          return;
        }
        const response = await entry.handler(interaction(entry.field, entry.platformId), service);
        const body = (await response.json()) as {
          type: number;
          data: { flags: number; content: string };
        };
        assert.equal(body.type, 4);
        assert.equal(body.data.flags, 64);
        assert.match(body.data.content, /link was saved, but follow-up processing is incomplete/i);
        assert.match(body.data.content, /Ask a server admin/);
        assert.ok(body.data.content.includes(entry.platformId));
        assert.deepEqual(effects, ["role", "audit"]);
        const saved = await service.getLinksByUser("guild-1", "user-1");
        assert.equal(saved.length, 1);
        assert.equal(saved[0]?.platformId, entry.platformId);
        assert.equal(saved[0]?.active, true);
      } finally {
        fixture.close();
      }
    });
  }
}

function interaction(field: string, platformId: string): DiscordInteraction {
  if (field === "psn_online_id") {
    return {
      type: 5,
      guild_id: "guild-1",
      member: { user: { id: "user-1" } },
      data: {
        custom_id: "playstation_link_modal",
        components: [{ type: 1, components: [{ type: 4, custom_id: field, value: platformId }] }],
      },
    };
  }
  return {
    type: 2,
    guild_id: "guild-1",
    member: { user: { id: "admin-1" } },
    data: {
      options: [
        {
          type: 1,
          name: "manual-link",
          options: [
            { name: "user", value: "user-1" },
            { name: field, value: platformId },
          ],
        },
      ],
    },
  };
}

function config(platform: PlatformLinkPlatform): PlatformLinkConfig {
  return {
    guildId: "guild-1",
    platform,
    linkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    panelTitle: "Link",
    panelDescription: "Link",
    panelButtonLabel: "Link",
    panelButtonStyle: "Primary",
    allowRelink: true,
    allowMultipleLinks: false,
    requireRelinkOnRejoin: false,
    whoisFields: [],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: 1,
  };
}
