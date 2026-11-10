/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { buildEphemeralMessage } from "../src/discord-interactions";
import { handleApplicationCommand } from "../src/runtime/application-command-handler";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";

test("/playercount remove attributes deletion to the command actor", async () => {
  const removals: Array<{ guildId: string; name: string; actorUserId: string | undefined }> = [];
  const response = await handleApplicationCommand(
    {
      type: 2,
      guild_id: "guild-1",
      member: { user: { id: "actor-1" }, permissions: "8" },
      data: {
        name: "playercount",
        options: [
          {
            name: "remove",
            type: 1,
            options: [{ name: "name", type: 3, value: "Main PvP" }],
          },
        ],
      },
    },
    {
      guildEntitlements: {
        async readGuildEntitlement(guildId: string) {
          return { guildId, tier: "premium", updatedAtMs: 1 };
        },
      },
    } as any,
    "bot-token",
    ALL_FEATURES_ENABLED,
    {
      services: {
        playerCountService: {
          async removeServer(guildId: string, name: string, actorUserId?: string) {
            removals.push({ guildId, name, actorUserId });
            return true;
          },
        } as any,
      },
    },
  );

  assert.deepEqual(await response.json(), buildEphemeralMessage('Removed server "Main PvP".'));
  assert.deepEqual(removals, [{ guildId: "guild-1", name: "Main PvP", actorUserId: "actor-1" }]);
});
