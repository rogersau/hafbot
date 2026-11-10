import assert from "node:assert/strict";
import test from "node:test";
import {
  createWebhookCredentialKeyRing,
  type WebhookCredentialOwner,
} from "../src/security/webhook-credentials";
import {
  WebhookCredentialService,
  type StoredWebhookCredential,
  type WebhookCredentialStore,
} from "../src/security/webhook-credentials/store";

test("credential service encrypts, masks, reveals repeatedly, and enforces owner binding", async () => {
  const records = new Map<string, StoredWebhookCredential>();
  const store: WebhookCredentialStore = {
    async readById(id) {
      return records.get(id) ?? null;
    },
    async readByOwner(owner) {
      return [...records.values()].find((entry) => sameOwner(entry.owner, owner)) ?? null;
    },
    async upsert(value) {
      records.set(value.credentialId, value);
    },
    async delete(id) {
      records.delete(id);
    },
  };
  const keyRing = createWebhookCredentialKeyRing({
    keyV1: Buffer.alloc(32, 7).toString("base64"),
  });
  const service = new WebhookCredentialService(store, keyRing);
  const owner: WebhookCredentialOwner = {
    kind: "proxy_destination",
    guildId: "guild-1",
    publicId: "public-source-1234",
    destinationId: "primary",
  };
  const url = "https://discord.com/api/webhooks/123456789012/token_value";
  const masked = await service.replace(owner, url, "00000000-0000-4000-8000-000000000001", 10);

  assert.equal(masked.configured, true);
  assert.equal(masked.maskedDisplay.includes("token_value"), false);
  assert.equal(JSON.stringify(records.get(masked.credentialId)).includes(url), false);
  assert.equal((await service.reveal(masked.credentialId, owner)).url, url);
  assert.equal((await service.reveal(masked.credentialId, owner)).url, url);

  await assert.rejects(
    service.reveal(masked.credentialId, { ...owner, guildId: "guild-2" }),
    /not found/i,
  );

  const suggestionOwner: WebhookCredentialOwner = {
    kind: "suggestion_reply",
    guildId: "guild-1",
    publicId: "reply-webhook",
  };
  const suggestion = await service.replace(
    suggestionOwner,
    "https://discord.com/api/webhooks/987654321098/suggestion_token",
    "00000000-0000-4000-8000-000000000002",
    11,
  );
  assert.equal(
    (await service.resolve(suggestion.credentialId, suggestionOwner)).url,
    "https://discord.com/api/webhooks/987654321098/suggestion_token",
  );
  assert.equal(
    JSON.stringify(records.get(suggestion.credentialId)).includes("suggestion_token"),
    false,
  );
});

function sameOwner(left: WebhookCredentialOwner, right: WebhookCredentialOwner): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
