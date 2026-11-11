/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import type { MessageTemplate, TicketTemplateReply } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("Message Template store persists ordered embeds and Ticket eligibility", async () => {
  const { createSqliteMessageTemplateStore } =
    await import("./support/sqlite/runtime/sqlite-message-template-store");
  const database = new SqliteD1Database();
  const store = createSqliteMessageTemplateStore(database as unknown as D1Database);
  const template: MessageTemplate = {
    id: "template-1",
    guildId: "guild-1",
    internalName: "Appeal denied",
    embeds: [
      { description: "First", fields: [{ name: "Outcome", value: "Denied", inline: false }] },
      { description: "Second", fields: [] },
    ],
    availableForTicketReplies: true,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
  await store.upsert(template);
  assert.deepEqual(await store.readById("guild-1", template.id), template);
  assert.deepEqual(await store.listTicketReplyTemplates("guild-1"), [template]);
  assert.equal(await store.countByGuild("guild-1"), 1);
});

test("Ticket store claims one confirmed Template Reply and retains accountability metadata", async () => {
  const { createSqliteTicketStore } = await import("./support/sqlite/runtime/sqlite-ticket-store");
  const database = new SqliteD1Database();
  const store = createSqliteTicketStore(database as unknown as D1Database);
  const reply: TicketTemplateReply = {
    interactionId: "interaction-1",
    guildId: "guild-1",
    ticketChannelId: "ticket-1",
    templateId: "template-1",
    templateInternalName: "Appeal denied",
    staffUserId: "staff-1",
    botMessageId: null,
    status: "pending",
    createdAtMs: 1,
  };
  assert.ok(store.claimTicketTemplateReply);
  assert.ok(store.completeTicketTemplateReply);
  assert.ok(store.listTicketTemplateReplies);
  assert.equal(await store.claimTicketTemplateReply(reply), true);
  assert.equal(await store.claimTicketTemplateReply(reply), false);
  await store.completeTicketTemplateReply({
    interactionId: reply.interactionId,
    botMessageId: "bot-1",
  });
  assert.deepEqual(await store.listTicketTemplateReplies("guild-1", "ticket-1"), [
    { ...reply, botMessageId: "bot-1", status: "sent" },
  ]);
});
