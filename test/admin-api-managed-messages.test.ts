/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createAdminApiHandler } from "./helpers/admin-api";
import type { CreateChannelMessageInput } from "../src/discord/messages";
import { createCloudflareManagedMessageStore } from "../src/runtime/cloudflare-managed-message-store";
import { ManagedMessageService } from "../src/services/managed-message-service";
import { ManagedMediaService, type PublicManagedMediaStore } from "../src/managed-media";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("Managed Message admin API exposes guild-scoped list, Save, and Delete operations", async () => {
  const database = new SqliteD1Database();
  const store = createCloudflareManagedMessageStore(database as unknown as D1Database);
  const discordCalls: string[] = [];
  const discordBodies: CreateChannelMessageInput[] = [];
  const service = new ManagedMessageService({
    store,
    guildEntitlements: {
      async readGuildEntitlement(guildId) {
        return { guildId, tier: "free", updatedAtMs: 0 };
      },
    },
    guildAuditLog: {
      async readConfig() {
        return null;
      },
      async upsertConfig() {},
    },
    discordBotToken: "token",
    discord: {
      async create(_channelId, body) {
        discordCalls.push("create");
        discordBodies.push(body);
        return { id: `discord-${discordCalls.filter((call) => call === "create").length}` };
      },
      async edit() {
        discordCalls.push("edit");
      },
      async delete() {
        discordCalls.push("delete");
      },
    },
    guildResources: {
      async read() {
        return { textChannelIds: ["channel-1"], roleIds: ["role-1"] };
      },
    },
  });
  const handler = createAdminApiHandler({
    stores: {} as never,
    discordBotToken: "token",
    services: { managedMessageService: service },
  });

  const draftResponse = await handler(
    new Request("https://example.com/admin/api/managed-messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save-draft",
        guildId: "guild-1",
        internalName: "draft-rules",
        channelId: "channel-1",
        embeds: [{ description: "Draft rules", fields: [] }],
        announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
      }),
    }),
    new URL("https://example.com/admin/api/managed-messages"),
  );
  assert.ok(draftResponse);
  assert.equal(draftResponse.status, 200);
  const draft = (await draftResponse.json()) as { draft: { id: string; status: string } };
  assert.equal(draft.draft.status, "draft");
  assert.deepEqual(discordCalls, []);

  const scheduleResponse = await handler(
    new Request("https://example.com/admin/api/managed-messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "schedule",
        guildId: "guild-1",
        id: draft.draft.id,
        internalName: "draft-rules",
        channelId: "channel-1",
        embeds: [{ description: "Scheduled rules", fields: [] }],
        announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
        scheduledAtMs: Date.now() + 60_000,
      }),
    }),
    new URL("https://example.com/admin/api/managed-messages"),
  );
  assert.ok(scheduleResponse);
  assert.equal(
    ((await scheduleResponse.json()) as { draft: { status: string } }).draft.status,
    "scheduled",
  );

  const cancelResponse = await handler(
    new Request("https://example.com/admin/api/managed-messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "cancel-schedule",
        guildId: "guild-1",
        id: draft.draft.id,
        internalName: "draft-rules",
        channelId: "channel-1",
        embeds: [{ description: "Scheduled rules", fields: [] }],
        announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
      }),
    }),
    new URL("https://example.com/admin/api/managed-messages"),
  );
  assert.ok(cancelResponse);
  assert.equal(
    ((await cancelResponse.json()) as { draft: { status: string } }).draft.status,
    "draft",
  );

  const publishResponse = await handler(
    new Request("https://example.com/admin/api/managed-messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "publish-draft",
        guildId: "guild-1",
        id: draft.draft.id,
        internalName: "draft-rules",
        channelId: "channel-1",
        embeds: [{ description: "Published rules", fields: [] }],
        announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
      }),
    }),
    new URL("https://example.com/admin/api/managed-messages"),
  );
  assert.ok(publishResponse);
  assert.equal(
    ((await publishResponse.json()) as { message: { status: string } }).message.status,
    "published",
  );

  const saveResponse = await handler(
    new Request("https://example.com/admin/api/managed-messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        internalName: "rules",
        channelId: "channel-1",
        embeds: [
          { description: "Rules", fields: [] },
          { description: "More rules", fields: [] },
        ],
        buttons: [{ label: "Support", url: "https://example.com/support", emoji: "🔗" }],
        announcement: {
          roleIds: ["role-1"],
          everyone: false,
          here: false,
          notifyOnCreate: false,
        },
      }),
    }),
    new URL("https://example.com/admin/api/managed-messages"),
  );

  assert.ok(saveResponse);
  assert.equal(saveResponse.status, 200);
  const saved = (await saveResponse.json()) as { message: { id: string } };
  const persisted = await store.readById("guild-1", saved.message.id);
  assert.equal(persisted?.embeds.length, 2);
  assert.deepEqual(persisted?.buttons, [
    { label: "Support", url: "https://example.com/support", emoji: "🔗" },
  ]);
  assert.deepEqual(discordBodies.at(-1)?.components, [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 5,
          label: "Support",
          url: "https://example.com/support",
          emoji: { name: "🔗" },
        },
      ],
    },
  ]);
  assert.deepEqual(discordCalls, ["create", "create"]);

  const listResponse = await handler(
    new Request("https://example.com/admin/api/managed-messages?guildId=guild-1"),
    new URL("https://example.com/admin/api/managed-messages?guildId=guild-1"),
  );
  assert.ok(listResponse);
  assert.equal(listResponse.status, 200);
  const listed = (await listResponse.json()) as { messages: unknown[]; drafts: unknown[] };
  assert.equal(listed.messages.length, 2);
  assert.equal(listed.drafts.length, 0);

  const disposableResponse = await handler(
    new Request("https://example.com/admin/api/managed-messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "save-draft",
        guildId: "guild-1",
        internalName: "disposable",
        channelId: "channel-1",
        embeds: [{ description: "Disposable", fields: [] }],
        announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
      }),
    }),
    new URL("https://example.com/admin/api/managed-messages"),
  );
  assert.ok(disposableResponse);
  const disposable = (await disposableResponse.json()) as { draft: { id: string } };
  const deleteDraftResponse = await handler(
    new Request("https://example.com/admin/api/managed-messages", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1", id: disposable.draft.id, draft: true }),
    }),
    new URL("https://example.com/admin/api/managed-messages"),
  );
  assert.ok(deleteDraftResponse);
  assert.deepEqual(await deleteDraftResponse.json(), { ok: true, deleted: true });
  assert.equal(await store.readDraftById("guild-1", disposable.draft.id), null);
  assert.deepEqual(discordCalls, ["create", "create"]);

  const deleteResponse = await handler(
    new Request("https://example.com/admin/api/managed-messages", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1", id: saved.message.id }),
    }),
    new URL("https://example.com/admin/api/managed-messages"),
  );
  assert.ok(deleteResponse);
  assert.equal(deleteResponse.status, 200);
  assert.deepEqual(await deleteResponse.json(), { ok: true, deleted: true });
  assert.equal(await store.readById("guild-1", saved.message.id), null);
  assert.deepEqual(discordCalls, ["create", "create", "delete"]);
});

test("Managed Message admin API rejects resources outside the authorized Guild", async () => {
  const database = new SqliteD1Database();
  const service = new ManagedMessageService({
    store: createCloudflareManagedMessageStore(database as unknown as D1Database),
    guildEntitlements: {
      async readGuildEntitlement(guildId) {
        return { guildId, tier: "free", updatedAtMs: 0 };
      },
    },
    guildAuditLog: {
      async readConfig() {
        return null;
      },
      async upsertConfig() {},
    },
    discordBotToken: "token",
    discord: {
      async create() {
        throw new Error("Discord must not be contacted");
      },
      async edit() {},
      async delete() {},
    },
    guildResources: {
      async read() {
        return { textChannelIds: ["channel-1"], roleIds: ["role-1"] };
      },
    },
  });
  const handler = createAdminApiHandler({
    stores: {} as never,
    discordBotToken: "token",
    services: { managedMessageService: service },
  });

  const response = await handler(
    new Request("https://example.com/admin/api/managed-messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        internalName: "rules",
        channelId: "other-guild-channel",
        embeds: [{ description: "Rules", fields: [] }],
        announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
      }),
    }),
    new URL("https://example.com/admin/api/managed-messages"),
  );

  assert.ok(response);
  assert.equal(response.status, 400);
  assert.match(JSON.stringify(await response.json()), /not a text channel in this Guild/);
});

test("Managed Message media upload compensates the blob when ownership registration fails", async () => {
  const database = new SqliteD1Database();
  const rawStore = createCloudflareManagedMessageStore(database as unknown as D1Database);
  const deleted: string[] = [];
  const blobs: PublicManagedMediaStore = {
    async putImage() {},
    async getImage() {
      return null;
    },
    async deleteImage({ filename }) {
      deleted.push(filename);
    },
  };
  const service = new ManagedMessageService({
    store: new Proxy(rawStore, {
      get(target, property, receiver) {
        if (property === "registerMediaAsset") {
          return async () => {
            throw new Error("ownership database unavailable");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    }),
    guildEntitlements: {
      async readGuildEntitlement(guildId) {
        return { guildId, tier: "free", updatedAtMs: 0 };
      },
    },
    guildAuditLog: {
      async readConfig() {
        return null;
      },
      async upsertConfig() {},
    },
    discordBotToken: "token",
    guildResources: {
      async read() {
        return { textChannelIds: ["channel-1"], roleIds: [] };
      },
    },
  });
  const handler = createAdminApiHandler({
    stores: {} as never,
    discordBotToken: "token",
    services: {
      managedMessageService: service,
      managedMediaService: new ManagedMediaService(blobs),
    },
  });
  const response = await handler(
    new Request("https://example.com/admin/api/managed-messages/media", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        guildId: "guild-1",
        filename: "upload.png",
        contentType: "image/png",
        dataBase64: "iVBORw0KGgo=",
      }),
    }),
    new URL("https://example.com/admin/api/managed-messages/media"),
  );
  assert.ok(response);
  assert.equal(response.status, 500);
  assert.equal(deleted.length, 1);
});
