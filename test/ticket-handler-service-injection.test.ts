/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { buildEphemeralMessage } from "../src/discord-interactions";
import type { DiscordInteraction, RuntimeStores } from "../src/runtime/app-types";
import {
  handleMessageComponentInteraction,
  type TicketComponentInteractionOptions,
} from "../src/runtime/ticket-interaction-handler";
import type { TicketLifecycle } from "../src/services/tickets/ticket-lifecycle";
import { buildTicketOpenCustomId } from "../src/tickets";

type PrepareOpenCommand = Parameters<TicketLifecycle["prepareOpen"]>[0];

// @ts-expect-error -- ticketLifecycle is required; the handler has no constructor fallback.
const optionsWithoutLifecycle: TicketComponentInteractionOptions = {
  stores: {} as RuntimeStores,
  discordBotToken: "synthetic-bot-token",
  requestOrigin: "https://runtime.example",
};
void optionsWithoutLifecycle;

/**
 * A store graph that fails on any access. The Ticket handler must dispatch
 * through the injected lifecycle rather than rebuilding one from stores.
 */
function undeclaredStores(): RuntimeStores {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `Unexpected store access ${String(property)}; the Ticket handler must use the injected lifecycle.`,
        );
      },
    },
  ) as unknown as RuntimeStores;
}

test("repeated component opens dispatch the same injected Ticket lifecycle without store fallback", async () => {
  const preparedCommands: PrepareOpenCommand[] = [];
  const ticketLifecycle = {
    async prepareOpen(command: PrepareOpenCommand) {
      preparedCommands.push(command);
      return {
        ok: false as const,
        code: "stale-config" as const,
        message: `Injected Ticket lifecycle call ${preparedCommands.length}`,
      };
    },
  } as unknown as TicketLifecycle;
  const options: TicketComponentInteractionOptions = {
    stores: undeclaredStores(),
    ticketLifecycle,
    discordBotToken: "synthetic-bot-token",
    requestOrigin: "https://runtime.example",
  };
  const interaction: DiscordInteraction = {
    type: 3,
    guild_id: "guild-1",
    channel_id: "panel-1",
    member: { user: { id: "member-1" }, roles: [] },
    data: { custom_id: buildTicketOpenCustomId("appeal") },
  };

  const responses: unknown[] = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await handleMessageComponentInteraction(interaction, options);
    assert.equal(response.status, 200);
    responses.push(await response.json());
  }

  assert.deepEqual(responses, [
    buildEphemeralMessage("Injected Ticket lifecycle call 1"),
    buildEphemeralMessage("Injected Ticket lifecycle call 2"),
  ]);
  const expectedCommand: PrepareOpenCommand = {
    guildId: "guild-1",
    panelId: "main",
    ticketTypeId: "appeal",
    memberRoleIds: [],
  };
  assert.deepEqual(preparedCommands, [expectedCommand, expectedCommand]);
});
