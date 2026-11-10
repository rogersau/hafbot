/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  buildAnonymousSupportHelperMessage,
  handleAnonymousStaffThreadMessageCreate,
  handleAnonymousStaffThreadMessageDelete,
  handleAnonymousStaffThreadMessageUpdate,
} from "../src/services/tickets/anonymous-staff-thread";
import type {
  AnonymousSupportDeliveryStore,
  TicketStore,
} from "../src/runtime/contracts/ticket-store";
import { afterStoreSeed, createProductionRuntimeStores } from "./support/production-runtime-stores";
import type { TicketInstance } from "../src/types";

test("buildAnonymousSupportHelperMessage explains anonymous and internal staff messages", () => {
  assert.deepEqual(buildAnonymousSupportHelperMessage(), {
    embeds: [
      {
        title: "Anonymous Support",
        description: "Reply to the member without exposing your Discord identity.",
        color: 0x5865f2,
        fields: [
          {
            name: "Send an anonymous reply",
            value: "Start your message with `!send`:\n`!send Your reply to the member`",
          },
          {
            name: "Keep a staff note private",
            value: "Post without `!send`. The message stays in this staff thread.",
          },
          {
            name: "Update a reply",
            value:
              "Edit or delete the original `!send` message to update or remove the bot's reply.",
          },
        ],
        footer: { text: "Attachments on !send messages are copied to the Ticket." },
      },
    ],
    allowed_mentions: { parse: [] },
  });
});

test("handleAnonymousStaffThreadMessageCreate proxies staff thread message without broad pings", async () => {
  const store = createStore({ ticket: createTicket() });
  const adapters = createAdapters();

  await handleAnonymousStaffThreadMessageCreate(store, adapters, {
    id: "staff-msg-1",
    channel_id: "thread-1",
    guild_id: "guild-1",
    content: "!send Hello <@user-1> <@&role-1> @everyone",
    type: 0,
    author: { id: "staff-1", username: "staff-user", global_name: "Staff Global" },
    member: { nick: "Staff Nick", roles: ["role-1"] },
  });

  assert.deepEqual(adapters.createdMessages, [
    {
      channelId: "ticket-channel-1",
      body: {
        content: "Hello <@user-1> <@&role-1> @everyone",
        allowed_mentions: { parse: [] },
        nonce: "ts:staff-msg-1",
        enforce_nonce: true,
      },
    },
  ]);
  assert.deepEqual(await readMapping(store, "staff-msg-1"), {
    ticketChannelId: "ticket-channel-1",
    botMessageId: "bot-msg-1",
    staffUserId: "staff-1",
    staffDisplayName: "Staff Nick",
    content: "Hello <@user-1> <@&role-1> @everyone",
  });
});

test("handleAnonymousStaffThreadMessageCreate proxies only when author has support role", async () => {
  const store = createStore({ ticket: createTicket() });
  const adapters = createAdapters();

  await handleAnonymousStaffThreadMessageCreate(store, adapters, {
    id: "staff-msg-1",
    channel_id: "thread-1",
    guild_id: "guild-1",
    content: "!send Hello",
    author: { id: "staff-1" },
    member: { roles: ["role-1", "role-2"] },
  });

  assert.equal(adapters.createdMessages.length, 1);
  assert.equal(adapters.adminAccessChecks, 0);
  assert.ok(await readMapping(store));
});

test("handleAnonymousStaffThreadMessageCreate proxies when author has admin access", async () => {
  const store = createStore({ ticket: createTicket() });
  const adapters = createAdapters({ adminAccess: true });

  await handleAnonymousStaffThreadMessageCreate(store, adapters, {
    id: "staff-msg-1",
    channel_id: "thread-1",
    guild_id: "guild-1",
    content: "!send Hello",
    author: { id: "admin-1" },
    member: { roles: ["admin-role"] },
  });

  assert.deepEqual(adapters.createdMessages, [
    {
      channelId: "ticket-channel-1",
      body: {
        content: "Hello",
        allowed_mentions: { parse: [] },
        nonce: "ts:staff-msg-1",
        enforce_nonce: true,
      },
    },
  ]);
  assert.equal(adapters.adminAccessChecks, 1);
  assert.ok(await readMapping(store));
});

test("handleAnonymousStaffThreadMessageCreate publishes a redelivered source message once", async () => {
  const store = createStore({ ticket: createTicket() });
  const adapters = createAdapters();
  const message = createAnonymousReplyMessage();

  await handleAnonymousStaffThreadMessageCreate(store, adapters, message);
  await handleAnonymousStaffThreadMessageCreate(store, adapters, message);

  assert.equal(adapters.createdMessages.length, 1);
  assert.ok(await readMapping(store, message.id));
});

test("handleAnonymousStaffThreadMessageCreate publishes concurrent redeliveries once", async () => {
  const store = createStore({ ticket: createTicket() });
  const adapters = createAdapters();
  const message = createAnonymousReplyMessage();

  await Promise.all([
    handleAnonymousStaffThreadMessageCreate(store, adapters, message),
    handleAnonymousStaffThreadMessageCreate(store, adapters, message),
  ]);

  assert.equal(adapters.createdMessages.length, 1);
  assert.ok(await readMapping(store, message.id));
});

test("handleAnonymousStaffThreadMessageCreate releases a claim after a pre-delivery failure", async () => {
  const store = createStore({ ticket: createTicket() });
  const adapters = createAdapters({ createFailures: 1 });
  const message = createAnonymousReplyMessage();

  await assert.rejects(
    handleAnonymousStaffThreadMessageCreate(store, adapters, message),
    /Discord delivery failed/,
  );
  await handleAnonymousStaffThreadMessageCreate(store, adapters, message);

  assert.equal(adapters.createdMessages.length, 1);
  assert.ok(await readMapping(store, message.id));
});

test("handleAnonymousStaffThreadMessageCreate does not resend after mapping completion fails", async () => {
  const store = createStore({ ticket: createTicket(), completeFailures: 1 });
  const adapters = createAdapters();
  const message = createAnonymousReplyMessage();

  await assert.rejects(
    handleAnonymousStaffThreadMessageCreate(store, adapters, message),
    /Mapping completion failed/,
  );
  await handleAnonymousStaffThreadMessageCreate(store, adapters, message);

  assert.equal(adapters.createdMessages.length, 1);
  assert.equal(await readMapping(store, message.id), null);
});

test("handleAnonymousStaffThreadMessageCreate explains denied send attempts", async () => {
  const store = createStore({ ticket: createTicket() });
  const adapters = createAdapters();

  await handleAnonymousStaffThreadMessageCreate(store, adapters, {
    id: "staff-msg-1",
    channel_id: "thread-1",
    guild_id: "guild-1",
    content: "!send Hello",
    author: { id: "staff-1" },
    member: { roles: ["role-2"] },
  });

  assert.deepEqual(adapters.createdMessages, [
    {
      channelId: "thread-1",
      body: {
        content:
          "You need the Ticket support role, Administrator, Manage Guild, or the configured HAF administrator role to use `!send`.",
        allowed_mentions: { parse: [], replied_user: false },
        message_reference: {
          message_id: "staff-msg-1",
          channel_id: "thread-1",
          guild_id: "guild-1",
        },
        nonce: "ts-denied:staff-msg-1",
        enforce_nonce: true,
      },
    },
  ]);
  assert.equal(adapters.adminAccessChecks, 1);
  assert.equal(await readMapping(store), null);
});

test("handleAnonymousStaffThreadMessageCreate proxies attachments by downloading files", async () => {
  const store = createStore({ ticket: createTicket() });
  const adapters = createAdapters({
    attachmentResponses: {
      "https://cdn.discordapp.com/file-1.png": new Response(
        new Blob(["image-data"], { type: "image/png" }),
      ),
    },
  });

  await handleAnonymousStaffThreadMessageCreate(store, adapters, {
    id: "staff-msg-1",
    channel_id: "thread-1",
    guild_id: "guild-1",
    content: "!send See attached",
    author: { id: "staff-1" },
    member: { roles: ["role-1"] },
    attachments: [
      {
        id: "attachment-1",
        filename: "proof.png",
        content_type: "image/png",
        url: "https://cdn.discordapp.com/file-1.png",
      },
    ],
  });

  assert.deepEqual(adapters.downloadedUrls, ["https://cdn.discordapp.com/file-1.png"]);
  assert.deepEqual(adapters.createdMessages, []);
  assert.equal(adapters.createdMessagesWithAttachments.length, 1);
  assert.equal(adapters.createdMessagesWithAttachments[0]?.channelId, "ticket-channel-1");
  assert.deepEqual(adapters.createdMessagesWithAttachments[0]?.body, {
    content: "See attached",
    allowed_mentions: { parse: [] },
    nonce: "ts:staff-msg-1",
    enforce_nonce: true,
  });
  assert.equal(adapters.createdMessagesWithAttachments[0]?.files.length, 1);
  assert.equal(adapters.createdMessagesWithAttachments[0]?.files[0]?.filename, "proof.png");
  assert.equal(adapters.createdMessagesWithAttachments[0]?.files[0]?.contentType, "image/png");
  assert.equal(
    await blobText(adapters.createdMessagesWithAttachments[0]?.files[0]?.data),
    "image-data",
  );
  assert.ok(await readMapping(store));
});

test("handleAnonymousStaffThreadMessageCreate proxies attachment-only message", async () => {
  const store = createStore({ ticket: createTicket() });
  const adapters = createAdapters({
    attachmentResponses: {
      "https://cdn.discordapp.com/file-1.txt": new Response("attachment body", {
        headers: { "Content-Type": "text/plain" },
      }),
    },
  });

  await handleAnonymousStaffThreadMessageCreate(store, adapters, {
    id: "staff-msg-1",
    channel_id: "thread-1",
    guild_id: "guild-1",
    content: "!send",
    author: { id: "staff-1" },
    member: { roles: ["role-1"] },
    attachments: [
      {
        id: "attachment-1",
        filename: "notes.txt",
        content_type: null,
        url: "https://cdn.discordapp.com/file-1.txt",
      },
    ],
  });

  assert.equal(adapters.createdMessagesWithAttachments.length, 1);
  assert.deepEqual(adapters.createdMessagesWithAttachments[0]?.body, {
    content: "",
    allowed_mentions: { parse: [] },
    nonce: "ts:staff-msg-1",
    enforce_nonce: true,
  });
  assert.equal(
    await blobText(adapters.createdMessagesWithAttachments[0]?.files[0]?.data),
    "attachment body",
  );
  assert.ok(await readMapping(store));
});

test("handleAnonymousStaffThreadMessageCreate does not partially proxy when attachment download fails", async () => {
  const store = createStore({ ticket: createTicket() });
  const adapters = createAdapters({
    attachmentResponses: {
      "https://cdn.discordapp.com/file-1.txt": new Response("not found", { status: 404 }),
    },
  });

  await assert.rejects(
    handleAnonymousStaffThreadMessageCreate(store, adapters, {
      id: "staff-msg-1",
      channel_id: "thread-1",
      guild_id: "guild-1",
      content: "!send See attached",
      author: { id: "staff-1" },
      member: { roles: ["role-1"] },
      attachments: [
        {
          id: "attachment-1",
          filename: "notes.txt",
          content_type: "text/plain",
          url: "https://cdn.discordapp.com/file-1.txt",
        },
      ],
    }),
    /Failed to download attachment: 404/,
  );

  assert.deepEqual(adapters.createdMessages, []);
  assert.deepEqual(adapters.createdMessagesWithAttachments, []);
  assert.equal(await readMapping(store), null);
});

test("handleAnonymousStaffThreadMessageCreate ignores bot messages", async () => {
  const store = createStore({ ticket: createTicket() });
  const adapters = createAdapters();

  await handleAnonymousStaffThreadMessageCreate(store, adapters, {
    id: "staff-msg-1",
    channel_id: "thread-1",
    guild_id: "guild-1",
    content: "Hello",
    author: { id: "bot-1", bot: true },
  });

  assert.deepEqual(adapters.createdMessages, []);
  assert.equal(adapters.adminAccessChecks, 0);
  assert.equal(await readMapping(store), null);
});

test("handleAnonymousStaffThreadMessageCreate keeps normal staff discussion messages internal", async () => {
  const store = createStore({ ticket: createTicket() });
  const adapters = createAdapters();

  await handleAnonymousStaffThreadMessageCreate(store, adapters, {
    id: "staff-msg-1",
    channel_id: "thread-1",
    guild_id: "guild-1",
    content: "This should stay in the staff thread",
    author: { id: "staff-1" },
    member: { roles: ["role-1"] },
  });

  assert.deepEqual(adapters.createdMessages, []);
  assert.equal(await readMapping(store), null);
});

test("handleAnonymousStaffThreadMessageCreate ignores slash-command-like messages", async () => {
  const store = createStore({ ticket: createTicket() });
  const adapters = createAdapters();

  await handleAnonymousStaffThreadMessageCreate(store, adapters, {
    id: "staff-msg-1",
    channel_id: "thread-1",
    guild_id: "guild-1",
    content: "  /close",
    author: { id: "staff-1" },
  });

  assert.deepEqual(adapters.createdMessages, []);
  assert.equal(await readMapping(store), null);
});

test("handleAnonymousStaffThreadMessageCreate ignores messages for unknown staff thread", async () => {
  const store = createStore({ ticket: null });
  const adapters = createAdapters();

  await handleAnonymousStaffThreadMessageCreate(store, adapters, {
    id: "staff-msg-1",
    channel_id: "thread-unknown",
    guild_id: "guild-1",
    content: "Hello",
    author: { id: "staff-1" },
  });

  assert.deepEqual(adapters.createdMessages, []);
  assert.equal(await readMapping(store), null);
});

test("handleAnonymousStaffThreadMessageUpdate preserves the send gate and strips its prefix", async () => {
  const store = createStore({
    mapping: {
      ticketChannelId: "ticket-channel-1",
      botMessageId: "bot-msg-1",
      staffUserId: "staff-1",
      staffDisplayName: "Old Name",
      content: "Old content",
    },
  });
  const adapters = createAdapters();

  await handleAnonymousStaffThreadMessageUpdate(store, adapters, {
    id: "staff-msg-1",
    channel_id: "thread-1",
    guild_id: "guild-1",
    content: "  !send Updated content",
    author: { id: "staff-1", username: "Staff Username" },
    member: { nick: null },
  });

  assert.deepEqual(adapters.editedMessages, [
    {
      channelId: "ticket-channel-1",
      messageId: "bot-msg-1",
      body: {
        content: "Updated content",
        allowed_mentions: { parse: [] },
      },
    },
  ]);
  assert.deepEqual(await readMapping(store), {
    ticketChannelId: "ticket-channel-1",
    botMessageId: "bot-msg-1",
    staffUserId: "staff-1",
    staffDisplayName: "Staff Username",
    content: "Updated content",
  });
});

test("handleAnonymousStaffThreadMessageUpdate ignores edits without the send prefix", async () => {
  const store = createStore({
    mapping: {
      ticketChannelId: "ticket-channel-1",
      botMessageId: "bot-msg-1",
      staffUserId: "staff-1",
      staffDisplayName: "Old Name",
      content: "Old content",
    },
  });
  const adapters = createAdapters();

  await handleAnonymousStaffThreadMessageUpdate(store, adapters, {
    id: "staff-msg-1",
    channel_id: "thread-1",
    guild_id: "guild-1",
    content: "Internal staff-only edit",
    author: { id: "staff-1" },
  });

  assert.deepEqual(adapters.editedMessages, []);
  assert.deepEqual(await readMapping(store), {
    ticketChannelId: "ticket-channel-1",
    botMessageId: "bot-msg-1",
    staffUserId: "staff-1",
    staffDisplayName: "Old Name",
    content: "Old content",
  });
});

test("handleAnonymousStaffThreadMessageDelete deletes bot message and removes mapping", async () => {
  const store = createStore({
    mapping: {
      ticketChannelId: "ticket-channel-1",
      botMessageId: "bot-msg-1",
      staffUserId: "staff-1",
      staffDisplayName: "Staff One",
      content: "Content",
    },
  });
  const adapters = createAdapters();

  await handleAnonymousStaffThreadMessageDelete(store, adapters, {
    id: "staff-msg-1",
    channel_id: "thread-1",
    guild_id: "guild-1",
  });

  assert.deepEqual(adapters.deletedMessages, [
    { channelId: "ticket-channel-1", messageId: "bot-msg-1" },
  ]);
  assert.equal(await readMapping(store), null);
});

function createTicket(): TicketInstance {
  return {
    guildId: "guild-1",
    channelId: "ticket-channel-1",
    panelId: "main",
    ticketTypeId: "appeals",
    ticketTypeLabel: "Appeal",
    openerUserId: "user-1",
    supportRoleId: "role-1",
    status: "open",
    answers: [],
    openedAtMs: 1,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: "thread-1",
  };
}

function createAnonymousReplyMessage() {
  return {
    id: "staff-msg-redelivery",
    channel_id: "thread-1",
    guild_id: "guild-1",
    content: "!send One reply only",
    type: 0,
    author: { id: "staff-1" },
    member: { roles: ["role-1"] },
  };
}

function createAdapters(options?: {
  attachmentResponses?: Record<string, Response>;
  createFailures?: number;
  adminAccess?: boolean;
}) {
  const createdMessages: Array<{ channelId: string; body: unknown }> = [];
  const createdMessagesWithAttachments: Array<{
    channelId: string;
    body: unknown;
    files: Array<{ filename: string; contentType: string | null; data: Blob | ArrayBuffer }>;
  }> = [];
  const editedMessages: Array<{ channelId: string; messageId: string; body: unknown }> = [];
  const deletedMessages: Array<{ channelId: string; messageId: string }> = [];
  const downloadedUrls: string[] = [];
  let createFailuresRemaining = options?.createFailures ?? 0;
  let adminAccessChecks = 0;

  return {
    createdMessages,
    createdMessagesWithAttachments,
    editedMessages,
    deletedMessages,
    downloadedUrls,
    get adminAccessChecks() {
      return adminAccessChecks;
    },
    now: () => 1234,
    async hasAdminAccess() {
      adminAccessChecks += 1;
      return options?.adminAccess ?? false;
    },
    async createChannelMessage(channelId: string, body: unknown) {
      if (createFailuresRemaining > 0) {
        createFailuresRemaining -= 1;
        throw new Error("Discord delivery failed");
      }
      createdMessages.push({ channelId, body });
      return { id: `bot-msg-${createdMessages.length}`, channel_id: channelId, content: "" };
    },
    async createChannelMessageWithAttachments(
      channelId: string,
      body: unknown,
      files: Array<{ filename: string; contentType: string | null; data: Blob | ArrayBuffer }>,
    ) {
      createdMessagesWithAttachments.push({ channelId, body, files });
      return {
        id: `bot-msg-with-attachments-${createdMessagesWithAttachments.length}`,
        channel_id: channelId,
        content: "",
      };
    },
    async fetchAttachment(url: string) {
      downloadedUrls.push(url);
      const response = options?.attachmentResponses?.[url];
      if (!response) {
        throw new Error(`Unexpected attachment URL: ${url}`);
      }
      return response;
    },
    async editChannelMessage(channelId: string, messageId: string, body: unknown) {
      editedMessages.push({ channelId, messageId, body });
      return { id: messageId, channel_id: channelId, content: "" };
    },
    async deleteChannelMessage(channelId: string, messageId: string) {
      deletedMessages.push({ channelId, messageId });
    },
  };
}

async function blobText(data: Blob | ArrayBuffer | undefined): Promise<string> {
  assert.ok(data);
  if (data instanceof Blob) {
    return await data.text();
  }
  return new TextDecoder().decode(data);
}

type AnonymousStaffStore = AnonymousSupportDeliveryStore;

function createStore(options: {
  ticket?: TicketInstance | null;
  completeFailures?: number;
  mapping?: {
    ticketChannelId: string;
    botMessageId: string;
    staffUserId: string;
    staffDisplayName: string;
    content: string;
  } | null;
}): AnonymousStaffStore {
  const fixture = createProductionRuntimeStores();
  const rawStore = fixture.stores.tickets;
  const ready = (async () => {
    await rawStore.upsertTicketPanelConfig(createTicketPanel());
    if (options.ticket) await rawStore.createTicketInstance(options.ticket);
    if (options.mapping) {
      await rawStore.recordStaffMessageMapping({
        guildId: "guild-1",
        ticketChannelId: options.mapping.ticketChannelId,
        staffThreadId: "thread-1",
        staffMessageId: "staff-msg-1",
        botMessageId: options.mapping.botMessageId,
        staffUserId: options.mapping.staffUserId,
        staffDisplayName: options.mapping.staffDisplayName,
        content: options.mapping.content,
        createdAtMs: 1234,
      });
    }
  })();
  const store = afterStoreSeed(rawStore, ready);
  if ((options.completeFailures ?? 0) > 0) {
    const complete = store.completeStaffMessageDelivery!.bind(store);
    let failuresRemaining = options.completeFailures ?? 0;
    store.completeStaffMessageDelivery = async (body) => {
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw new Error("Mapping completion failed");
      }
      await complete(body);
    };
  }
  return store as AnonymousSupportDeliveryStore;
}

async function readMapping(store: TicketStore, staffMessageId = "staff-msg-1") {
  return await store.readStaffMessageMappingByStaffMessage({
    guildId: "guild-1",
    staffThreadId: "thread-1",
    staffMessageId,
  });
}

function createTicketPanel() {
  return {
    guildId: "guild-1",
    panelId: "main",
    panelName: "Main panel",
    panelChannelId: "panel",
    categoryChannelId: "category",
    transcriptChannelId: "transcripts",
    panelEmoji: null,
    panelTitle: null,
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: false,
    aiTranscriptSummariesEnabled: false,
    ticketTypes: [
      {
        id: "appeals",
        label: "Appeal",
        emoji: null,
        buttonStyle: "primary" as const,
        supportRoleId: "role-1",
        channelNamePrefix: "appeal",
        questions: [],
        autoReplyEnabled: false,
        autoReplyMessage: null,
        responseRules: [],
        anonymousEnabled: false,
        anonymousSupportEnabled: true,
        staffDiscussionThreadEnabled: true,
        ticketHistoryPromptVisibility: "off" as const,
        limitExclusion: false,
        mentionSupportRole: false,
      },
    ],
  };
}
