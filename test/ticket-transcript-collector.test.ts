/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Test compiled via tsconfig.tests.json.
import test from "node:test";

import {
  buildTicketTranscriptArtifacts,
  mapDiscordMessagesToTicketTranscriptMessages,
} from "../src/runtime/ticket-transcript-collector";
import { TICKET_TRANSCRIPT_ACCESS_TOKEN_PLACEHOLDER } from "../src/tickets";
import type { DiscordMessageListItem } from "../src/discord/messages";
import { createCloudflareTicketTranscriptCapabilityStore } from "../src/runtime/cloudflare-ticket-transcript-capability-store";
import type { TicketInstance } from "../src/types";
import { SqliteD1Database } from "./support/sqlite-d1-database";

test("buildTicketTranscriptArtifacts issues expiring access separate from its object key", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  Date.now = () => 1_000;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/channels/channel-1/messages")) return Response.json([]);
    if (url.endsWith("/users/@me/guilds"))
      return Response.json([{ id: "guild-1", name: "Guild One", icon: null }]);
    if (url.endsWith("/guilds/guild-1/channels"))
      return Response.json([{ id: "channel-1", name: "ticket-one", type: 0 }]);
    if (url.endsWith("/guilds/guild-1/roles")) return Response.json([]);
    throw new Error(`Unexpected Discord request: ${url}`);
  }) as typeof fetch;
  const database = new SqliteD1Database();
  const capabilities = createCloudflareTicketTranscriptCapabilityStore(database.d1);
  const htmlKeys: string[] = [];
  const deleted: Array<{ guildId: string; channelId: string; objectId: string }> = [];

  try {
    const artifacts = await buildTicketTranscriptArtifacts({
      guildId: "guild-1",
      channelId: "channel-1",
      closingTicket: {
        guildId: "guild-1",
        channelId: "channel-1",
        panelId: "main",
        ticketTypeId: "support",
        ticketTypeLabel: "Support",
        openerUserId: "user-1",
        supportRoleId: "role-1",
        status: "closed",
        answers: [],
        openedAtMs: 500,
        closedAtMs: 900,
        closedByUserId: "staff-1",
        transcriptMessageId: null,
        staffThreadId: null,
        claimedByUserId: null,
        claimedAtMs: null,
      } satisfies TicketInstance,
      closerDisplayName: "Staff One",
      discordBotToken: "bot-token",
      requestOrigin: "https://worker.example",
      ticketTranscriptCapabilities: capabilities,
      ticketTranscriptBlobs: {
        putHtml: async (key) => {
          htmlKeys.push(key);
        },
        getHtml: async () => null,
        putAttachment: async () => {},
        getAttachment: async () => null,
        deleteTranscriptArtifacts: async (input) => {
          deleted.push(input);
          throw new Error("R2 unavailable");
        },
      },
    });

    assert.ok(artifacts.accessToken);
    assert.match(artifacts.htmlUrl ?? "", new RegExp(`/${artifacts.accessToken}$`));
    assert.equal(htmlKeys.length, 1);
    assert.equal(htmlKeys[0]?.includes(artifacts.accessToken), false);
    assert.ok(
      await capabilities.authorize({
        guildId: "guild-1",
        channelId: "channel-1",
        accessToken: artifacts.accessToken,
        nowMs: 1_001,
      }),
    );
    assert.ok(artifacts.discard);
    await assert.rejects(artifacts.discard(), /R2 unavailable/);
    assert.equal(deleted.length, 1);
    assert.equal(
      await capabilities.authorize({
        guildId: "guild-1",
        channelId: "channel-1",
        accessToken: artifacts.accessToken,
        nowMs: 1_002,
      }),
      null,
    );
    await capabilities.issue({
      objectId: "replacement-object",
      guildId: "guild-1",
      channelId: "channel-1",
      accessToken: "replacement-token",
      createdAtMs: 1_002,
      expiresAtMs: 2_000,
      retentionExpiresAtMs: 3_000,
    });
    assert.deepEqual(await capabilities.listRetentionExpired(1_000, 10), [
      { objectId: deleted[0]!.objectId, guildId: "guild-1", channelId: "channel-1" },
    ]);
  } finally {
    database.close();
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

test("buildTicketTranscriptArtifacts omits failed attachment URLs and cleans up failed issuance", async () => {
  const originalFetch = globalThis.fetch;
  let storedHtml = "";
  let issuedAccessToken = "";
  const deleted: Array<{ guildId: string; channelId: string; objectId: string }> = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/channels/channel-1/messages")) {
      return Response.json([
        {
          id: "message-1",
          channel_id: "channel-1",
          content: "Evidence",
          timestamp: "2026-07-30T00:00:00.000Z",
          author: { id: "user-1", username: "user", discriminator: "0001" },
          attachments: [
            {
              id: "attachment-success",
              filename: "archived.png",
              content_type: "image/png",
              url: "https://cdn.discordapp.com/private/archived.png",
            },
            {
              id: "attachment-1",
              filename: "proof.png",
              content_type: "image/png",
              url: "https://cdn.discordapp.com/private/proof.png",
            },
          ],
        },
      ]);
    }
    if (url.endsWith("/users/@me/guilds"))
      return Response.json([{ id: "guild-1", name: "Guild One", icon: null }]);
    if (url.endsWith("/guilds/guild-1/channels"))
      return Response.json([{ id: "channel-1", name: "ticket-one", type: 0 }]);
    if (url.endsWith("/guilds/guild-1/roles")) return Response.json([]);
    if (url === "https://cdn.discordapp.com/private/proof.png") {
      return new Response(null, { status: 503 });
    }
    if (url === "https://cdn.discordapp.com/private/archived.png") {
      return new Response("image", { headers: { "content-type": "image/png" } });
    }
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      buildTicketTranscriptArtifacts({
        guildId: "guild-1",
        channelId: "channel-1",
        closingTicket: {
          guildId: "guild-1",
          channelId: "channel-1",
          panelId: "main",
          ticketTypeId: "support",
          ticketTypeLabel: "Support",
          openerUserId: "user-1",
          supportRoleId: "role-1",
          status: "closed",
          answers: [],
          openedAtMs: 500,
          closedAtMs: 900,
          closedByUserId: "staff-1",
          transcriptMessageId: null,
          staffThreadId: null,
          claimedByUserId: null,
          claimedAtMs: null,
        },
        closerDisplayName: "Staff One",
        discordBotToken: "bot-token",
        requestOrigin: "https://worker.example",
        ticketTranscriptCapabilities: {
          async issue(input: { accessToken: string }) {
            issuedAccessToken = input.accessToken;
            throw new Error("D1 unavailable");
          },
        } as never,
        ticketTranscriptBlobs: {
          async putHtml(_key, html) {
            storedHtml = html;
          },
          getHtml: async () => null,
          putAttachment: async () => {},
          getAttachment: async () => null,
          async deleteTranscriptArtifacts(input) {
            deleted.push(input);
          },
        },
      }),
      /D1 unavailable/,
    );

    assert.doesNotMatch(storedHtml, /cdn\.discordapp\.com\/private\/proof\.png|proof\.png/);
    assert.match(storedHtml, new RegExp(TICKET_TRANSCRIPT_ACCESS_TOKEN_PLACEHOLDER));
    assert.equal(storedHtml.includes(issuedAccessToken), false);
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0]?.guildId, "guild-1");
    assert.equal(deleted[0]?.channelId, "channel-1");
    assert.ok(deleted[0]?.objectId);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("Ticket transcript capability access timestamps never move backwards", async () => {
  const database = new SqliteD1Database();
  const capabilities = createCloudflareTicketTranscriptCapabilityStore(database.d1);
  try {
    await capabilities.issue({
      objectId: "transcript-object-1",
      guildId: "guild-1",
      channelId: "channel-1",
      accessToken: "access-token",
      createdAtMs: 1,
      expiresAtMs: 1_000,
      retentionExpiresAtMs: 2_000,
    });
    await capabilities.authorize({
      guildId: "guild-1",
      channelId: "channel-1",
      accessToken: "access-token",
      nowMs: 200,
    });
    await capabilities.authorize({
      guildId: "guild-1",
      channelId: "channel-1",
      accessToken: "access-token",
      nowMs: 100,
    });

    assert.deepEqual(
      database.query<{ lastAccessedAtMs: number; accessCount: number }>(
        `SELECT last_accessed_at_ms AS lastAccessedAtMs, access_count AS accessCount
         FROM ticket_transcript_capabilities`,
      ),
      [{ lastAccessedAtMs: 200, accessCount: 2 }],
    );
    await capabilities.issue({
      objectId: "transcript-object-2",
      guildId: "guild-1",
      channelId: "channel-1",
      accessToken: "replacement-token",
      createdAtMs: 300,
      expiresAtMs: 1_000,
      retentionExpiresAtMs: 2_000,
    });
    assert.deepEqual(await capabilities.listRetentionExpired(300, 10), [
      { objectId: "transcript-object-1", guildId: "guild-1", channelId: "channel-1" },
    ]);
    assert.equal(
      await capabilities.authorize({
        guildId: "guild-1",
        channelId: "channel-1",
        accessToken: "access-token",
        nowMs: 301,
      }),
      null,
    );
  } finally {
    database.close();
  }
});

test("mapDiscordMessagesToTicketTranscriptMessages attributes proxied staff bot messages", async () => {
  const messages: DiscordMessageListItem[] = [
    {
      id: "message-1",
      channel_id: "ticket-1",
      content: "Internal reply",
      timestamp: "2024-01-01T00:00:00.000Z",
      author: {
        id: "bot-1",
        username: "TicketBot",
        discriminator: "0000",
        global_name: "Helper Bot",
        avatar: "bot-avatar-hash",
      },
      attachments: [],
    },
  ];

  const transcriptMessages = await mapDiscordMessagesToTicketTranscriptMessages(
    messages,
    "guild-1",
    "ticket-1",
    {
      readStaffMessageMapping: async (body) => {
        assert.deepEqual(body, {
          guildId: "guild-1",
          ticketChannelId: "ticket-1",
          botMessageId: "message-1",
        });
        return { staffUserId: "staff-1", staffDisplayName: "Mod Alice" };
      },
    },
  );

  assert.equal(transcriptMessages[0].authorId, "bot-1");
  assert.equal(transcriptMessages[0].authorTag, "Helper Bot (Mod Alice)");
  assert.equal(
    transcriptMessages[0].authorAvatarUrl,
    "https://cdn.discordapp.com/avatars/bot-1/bot-avatar-hash.png?size=128",
  );
});

test("mapDiscordMessagesToTicketTranscriptMessages resolves replies to earlier messages", async () => {
  const messages: DiscordMessageListItem[] = [
    {
      id: "message-1",
      channel_id: "ticket-1",
      content: "Original message",
      timestamp: "2024-01-01T00:00:00.000Z",
      author: {
        id: "user-1",
        username: "UserOne",
        discriminator: "0001",
        global_name: "User One",
        avatar: "user1-avatar-hash",
      },
      attachments: [],
    },
    {
      id: "message-2",
      channel_id: "ticket-1",
      content: "Reply message",
      timestamp: "2024-01-01T00:00:01.000Z",
      author: {
        id: "user-2",
        username: "UserTwo",
        discriminator: "0002",
        global_name: "User Two",
        avatar: null,
      },
      attachments: [],
      message_reference: { message_id: "message-1", channel_id: "ticket-1", guild_id: "guild-1" },
    },
  ];

  const transcriptMessages = await mapDiscordMessagesToTicketTranscriptMessages(
    messages,
    "guild-1",
    "ticket-1",
  );

  assert.equal(transcriptMessages[1].replyToMessageId, "message-1");
  assert.equal(transcriptMessages[1].replyTo?.authorTag, "User One");
  assert.equal(
    transcriptMessages[1].replyTo?.authorAvatarUrl,
    "https://cdn.discordapp.com/avatars/user-1/user1-avatar-hash.png?size=128",
  );
  assert.equal(transcriptMessages[1].replyTo?.content, "Original message");
});

test("mapDiscordMessagesToTicketTranscriptMessages marks missing reply targets unavailable", async () => {
  const messages: DiscordMessageListItem[] = [
    {
      id: "message-2",
      channel_id: "ticket-1",
      content: "Reply message",
      timestamp: "2024-01-01T00:00:01.000Z",
      author: {
        id: "user-2",
        username: "UserTwo",
        discriminator: "0002",
        global_name: "User Two",
        avatar: null,
      },
      attachments: [],
      message_reference: { message_id: "message-1", channel_id: "ticket-1", guild_id: "guild-1" },
    },
  ];

  const transcriptMessages = await mapDiscordMessagesToTicketTranscriptMessages(
    messages,
    "guild-1",
    "ticket-1",
  );

  assert.equal(transcriptMessages[0].replyToMessageId, "message-1");
  assert.equal(transcriptMessages[0].replyTo?.authorTag, null);
  assert.equal(transcriptMessages[0].replyTo?.content, "[original message unavailable]");
});
