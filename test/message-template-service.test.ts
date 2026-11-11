/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { MessageTemplateService } from "../src/services/message-template-service";
import { buildMessageTemplateAuditEmbed } from "../src/services/guild-audit-log-service";
import { QuantityLimitError } from "../src/runtime/entitlement-checks";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

async function createHarness(tier: "free" | "premium" = "free") {
  const fixture = await createProductionRuntimeStores();
  if (tier !== "free") {
    fixture.database.execRaw(
      `INSERT INTO guild_entitlements (guild_id, plan, updated_at_ms) VALUES ('guild-1', '${tier}', 1)`,
    );
  }
  const service = new MessageTemplateService({
    store: fixture.stores.messageTemplates!,
    guildEntitlements: fixture.stores.guildEntitlements,
    guildAuditLog: fixture.stores.guildAuditLog,
    discordBotToken: "token",
  });
  return { service, fixture };
}

const embeds = [{ description: " Saved reply ", fields: [] }];

test("MessageTemplateService creates reusable embed templates and filters Ticket eligibility", async () => {
  const { service, fixture } = await createHarness();
  try {
    const saved = await service.save({
      guildId: "guild-1",
      internalName: "Appeal denied",
      embeds,
      availableForTicketReplies: true,
    });
    assert.equal(saved.embeds[0]?.description, "Saved reply");
    assert.equal((await service.listTicketReplyTemplates("guild-1"))[0]?.id, saved.id);
  } finally {
    fixture.close();
  }
});

test("MessageTemplateService duplicates by value and later edits do not propagate", async () => {
  const { service, fixture } = await createHarness("premium");
  try {
    const original = await service.save({
      guildId: "guild-1",
      internalName: "Offline",
      embeds,
      availableForTicketReplies: false,
    });
    const duplicate = await service.duplicate("guild-1", original.id, "Offline copy");
    await service.save({ ...original, embeds: [{ description: "Changed", fields: [] }] });
    assert.equal(
      (await service.read("guild-1", duplicate.id))?.embeds[0]?.description,
      "Saved reply",
    );
  } finally {
    fixture.close();
  }
});

test("MessageTemplateService enforces a separate Free limit of three", async () => {
  const { service, fixture } = await createHarness();
  try {
    for (let index = 1; index <= 3; index += 1) {
      await service.save({
        guildId: "guild-1",
        internalName: `Template ${index}`,
        embeds,
        availableForTicketReplies: false,
      });
    }
    await assert.rejects(
      service.save({
        guildId: "guild-1",
        internalName: "Template 4",
        embeds,
        availableForTicketReplies: false,
      }),
      QuantityLimitError,
    );
  } finally {
    fixture.close();
  }
});

test("Message Template audit embeds contain metadata but not embed content", () => {
  const embed = buildMessageTemplateAuditEmbed("message-template.update", {
    guildId: "guild-1",
    internalName: "Appeal denied",
    actorUserId: "staff-1",
  });
  assert.match(JSON.stringify(embed), /Appeal denied/);
  assert.doesNotMatch(JSON.stringify(embed), /Saved reply/);
});
