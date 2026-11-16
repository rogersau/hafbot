/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import { createPublicRoutes } from "../src/routes/public-routes";
import { allowAllAdminAccess } from "./helpers/admin-api";
import { dispatchAdminRoute } from "../src/runtime/admin-route-registry";
import { createTicketAdminRoutes } from "../src/runtime/admin-routes/tickets";
import { createSqliteTicketTranscriptCapabilityStore } from "./support/sqlite/runtime/sqlite-ticket-transcript-capability-store";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import { SqliteD1Database } from "./support/sqlite-d1-database";
import { TICKET_TRANSCRIPT_ACCESS_TOKEN_PLACEHOLDER } from "../src/tickets";

test("Ticket Admin rotates a transcript link and invalidates its previous bearer token", async () => {
  const database = new SqliteD1Database();
  const capabilities = createSqliteTicketTranscriptCapabilityStore(database.d1);
  const nowMs = Date.now();
  await capabilities.issue({
    objectId: "transcript-object-1",
    guildId: "guild-1",
    channelId: "channel-1",
    accessToken: "old-token",
    createdAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 10_000,
    retentionExpiresAtMs: nowMs + 20_000,
  });
  const ticketTranscriptBlobs = {
    putHtml: async () => {},
    getHtml: async (key: string) =>
      key === "guild-1/channel-1/transcript-object-1.html"
        ? `<html><p>User text /${TICKET_TRANSCRIPT_ACCESS_TOKEN_PLACEHOLDER}/media/not-an-attachment</p><img src="https://worker.example/transcripts/guild-1/channel-1/${TICKET_TRANSCRIPT_ACCESS_TOKEN_PLACEHOLDER}/media/attachment-1/proof.png"></html>`
        : null,
    putAttachment: async () => {},
    getAttachment: async (key: string) =>
      key === "guild-1/channel-1/transcript-object-1/attachments/attachment-1/proof.png"
        ? { body: "image", contentType: "image/png" }
        : null,
  };
  const adminRequest = new Request("https://worker.example/admin/api/tickets/transcript/rotate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ guildId: "guild-1", channelId: "channel-1" }),
  });

  try {
    const response = await dispatchAdminRoute(
      createTicketAdminRoutes({
        stores: {} as never,
        adminAccess: allowAllAdminAccess,
        discordBotToken: "bot-token",
        ticketTranscriptCapabilities: capabilities,
        publicBaseUrl: "https://worker.example",
      } as never),
      adminRequest,
      {
        adminAccess: allowAllAdminAccess,
        features: ALL_FEATURES_ENABLED,
        stores: {} as never,
      },
    );
    assert.equal(response?.status, 200);
    const rotated = (await response?.json()) as { url: string; expiresAtMs: number };
    assert.match(rotated.url, /^https:\/\/worker\.example\/transcripts\/guild-1\/channel-1\//);
    assert.ok(rotated.expiresAtMs > nowMs);

    const publicRoutes = createPublicRoutes({
      features: ALL_FEATURES_ENABLED,
      ticketTranscriptCapabilities: capabilities,
      ticketTranscriptBlobs,
    });
    const oldResponse = await publicRoutes(
      new Request("https://worker.example/transcripts/guild-1/channel-1/old-token"),
    );
    const newResponse = await publicRoutes(new Request(rotated.url));

    assert.equal(oldResponse?.status, 404);
    assert.equal(newResponse?.status, 200);
    const rotatedHtml = await newResponse?.text();
    assert.doesNotMatch(rotatedHtml ?? "", /old-token/);
    assert.match(
      rotatedHtml ?? "",
      new RegExp(`User text /${TICKET_TRANSCRIPT_ACCESS_TOKEN_PLACEHOLDER}/media/`),
    );
    const attachmentUrl = /src="([^"]+)"/.exec(rotatedHtml ?? "")?.[1];
    assert.ok(attachmentUrl);
    const attachmentResponse = await publicRoutes(new Request(attachmentUrl));
    assert.equal(attachmentResponse?.status, 200);
    assert.equal(await attachmentResponse?.text(), "image");
  } finally {
    database.close();
  }
});

test("Ticket Admin revokes a leaked transcript link", async () => {
  const database = new SqliteD1Database();
  const capabilities = createSqliteTicketTranscriptCapabilityStore(database.d1);
  const nowMs = Date.now();
  await capabilities.issue({
    objectId: "transcript-object-1",
    guildId: "guild-1",
    channelId: "channel-1",
    accessToken: "leaked-token",
    createdAtMs: nowMs - 1_000,
    expiresAtMs: nowMs + 10_000,
    retentionExpiresAtMs: nowMs + 20_000,
  });

  try {
    const request = new Request("https://worker.example/admin/api/tickets/transcript/revoke", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ guildId: "guild-1", channelId: "channel-1" }),
    });
    const response = await dispatchAdminRoute(
      createTicketAdminRoutes({
        stores: {} as never,
        adminAccess: allowAllAdminAccess,
        discordBotToken: "bot-token",
        ticketTranscriptCapabilities: capabilities,
      } as never),
      request,
      {
        adminAccess: allowAllAdminAccess,
        features: ALL_FEATURES_ENABLED,
        stores: {} as never,
      },
    );

    assert.equal(response?.status, 200);
    assert.deepEqual(await response?.json(), { ok: true });
    assert.equal(
      await capabilities.authorize({
        guildId: "guild-1",
        channelId: "channel-1",
        accessToken: "leaked-token",
        nowMs: nowMs + 1,
      }),
      null,
    );
  } finally {
    database.close();
  }
});
