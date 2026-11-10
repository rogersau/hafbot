/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import {
  handleMessageComponentInteraction,
  handleTicketReplyAutocompleteInteraction,
  handleTicketSlashCommandInteraction,
} from "../src/runtime/ticket-interaction-handler";
import { buildTicketTemplateReplyCustomId } from "../src/tickets";
import type { DiscordInteraction, RuntimeStores } from "../src/runtime/app-types";
import type { MessageTemplate, TicketInstance, TicketTemplateReply } from "../src/types";

const ticket: TicketInstance = {
  guildId: "guild-1",
  channelId: "ticket-1",
  panelId: "main",
  ticketTypeId: "appeal",
  ticketTypeLabel: "Appeal",
  openerUserId: "member-1",
  supportRoleId: "support-1",
  status: "open",
  answers: [],
  openedAtMs: 1,
  closedAtMs: null,
  closedByUserId: null,
  transcriptMessageId: null,
  staffThreadId: "staff-thread-1",
  claimedByUserId: null,
  claimedAtMs: null,
};
const template: MessageTemplate = {
  id: "template-1",
  guildId: "guild-1",
  internalName: "Appeal denied",
  embeds: [{ title: "Appeal outcome", description: "Your appeal was denied.", fields: [] }],
  availableForTicketReplies: true,
  createdAtMs: 1,
  updatedAtMs: 1,
};

function stores(overrides: Record<string, unknown> = {}): RuntimeStores {
  const claimed = new Set<string>();
  return {
    tickets: {
      async readOpenTicketByChannel(_guildId: string, channelId: string) {
        return channelId === ticket.channelId ? ticket : null;
      },
      async readOpenTicketByStaffThread(_guildId: string, channelId: string) {
        return channelId === ticket.staffThreadId ? ticket : null;
      },
      async claimTicketTemplateReply(reply: TicketTemplateReply) {
        if (claimed.has(reply.interactionId)) return false;
        claimed.add(reply.interactionId);
        (overrides.claimed as TicketTemplateReply[] | undefined)?.push(reply);
        return true;
      },
      async completeTicketTemplateReply(body: { interactionId: string; botMessageId: string }) {
        (
          overrides.completed as Array<{ interactionId: string; botMessageId: string }> | undefined
        )?.push(body);
      },
      async releaseTicketTemplateReply() {},
    },
    messageTemplates: {
      async listByGuild() {
        return [template];
      },
      async listTicketReplyTemplates() {
        return [template];
      },
      async readById(guildId: string, id: string) {
        return guildId === template.guildId && id === template.id ? template : null;
      },
      async countByGuild() {
        return 1;
      },
      async upsert() {},
      async delete() {},
    },
    ...overrides,
  } as unknown as RuntimeStores;
}

function interaction(type: number, channelId = "staff-thread-1"): DiscordInteraction {
  return {
    id: "interaction-1",
    type,
    guild_id: "guild-1",
    channel_id: channelId,
    member: { roles: ["support-1"], user: { id: "staff-1", username: "Staff" } },
    data: {
      name: "ticket",
      options: [
        {
          type: 1,
          name: "reply",
          options: [
            {
              type: 3,
              name: "template",
              value: type === 4 ? "appeal" : template.id,
              focused: type === 4,
            },
          ],
        },
      ],
    },
  };
}

test("Ticket reply autocomplete returns only eligible Guild templates in Ticket context", async () => {
  const response = await handleTicketReplyAutocompleteInteraction(interaction(4), stores());
  assert.deepEqual(((await response.json()) as any).data.choices, [
    { name: "Appeal denied", value: "template-1" },
  ]);
});

test("Ticket reply command previews embeds ephemerally before sending", async () => {
  const response = await handleTicketSlashCommandInteraction(
    interaction(2),
    stores(),
    "token",
    "https://runtime.example",
    "reply",
    undefined,
    undefined,
    undefined,
    template.id,
  );
  const body = (await response.json()) as any;
  assert.equal(body.data.flags, 64);
  assert.equal(body.data.embeds[0].description, "Your appeal was denied.");
  assert.equal(body.data.components[0].components[0].label, "Send");
});

test("confirmed Staff Discussion Thread reply is delivered once and records the actor", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = async (input) => {
    requests.push(String(input));
    return Response.json({ id: "bot-message-1" });
  };
  const claimed: TicketTemplateReply[] = [];
  const completed: Array<{ interactionId: string; botMessageId: string }> = [];
  const runtimeStores = stores({ claimed, completed });
  const component = interaction(3);
  component.data = {
    custom_id: buildTicketTemplateReplyCustomId(
      ticket.channelId,
      template.id,
      template.updatedAtMs,
    ),
  };
  try {
    const first = await handleMessageComponentInteraction(
      component,
      runtimeStores,
      "token",
      "https://runtime.example",
    );
    assert.equal(((await first.json()) as any).data.content, "Sent **Appeal denied**.");
    const second = await handleMessageComponentInteraction(
      component,
      runtimeStores,
      "token",
      "https://runtime.example",
    );
    assert.match(((await second.json()) as any).data.content, /already sent/);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(requests.length, 1);
  assert.match(requests[0] ?? "", /channels\/ticket-1\/messages/);
  assert.equal(claimed[0]?.staffUserId, "staff-1");
  assert.deepEqual(completed, [{ interactionId: "interaction-1", botMessageId: "bot-message-1" }]);
});
