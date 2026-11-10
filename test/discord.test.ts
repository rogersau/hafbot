/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import {
  addGuildMemberRole,
  createTicketChannel,
  createChannelMessageWithAttachments,
  DiscordApiError,
  discordGetJson,
  discordOAuthGetJson,
  editOriginalInteractionResponse,
  isDiscordRateLimitError,
  fetchGuildMember,
  guildMemberHasRole,
  removeGuildMemberRole,
  uploadTranscriptToChannel,
} from "../src/discord";
import { leaveGuild, listBotGuilds, listGuildTicketResources } from "../src/discord/guilds";
import {
  addTicketParticipantAccess,
  configureBotDefenseHoneypotChannel,
  createPrivateThread,
  createTicketChannel as createTicketChannelFromChannels,
  ensureForumTags,
  readTicketParticipantAccess,
  removeTicketParticipantAccess,
} from "../src/discord/channels";

test("createPrivateThread requests a non-invitable Discord private thread", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({ id: "staff-thread-1" });
  }) as typeof fetch;

  try {
    assert.deepEqual(await createPrivateThread("ticket-1", "Staff Discussion", "bot-token"), {
      id: "staff-thread-1",
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [
    {
      url: "https://discord.com/api/v10/channels/ticket-1/threads",
      method: "POST",
      body: { name: "Staff Discussion", type: 12, invitable: false },
    },
  ]);
});

test("Ticket participant access uses only the selected member overwrite endpoint", async () => {
  const calls: Array<{ input: string; method: string; body: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({
      input: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? init.body : null,
    });
    return new Response(null, { status: 204 });
  };
  try {
    await addTicketParticipantAccess("ticket-1", "user-1", "token");
    await removeTicketParticipantAccess("ticket-1", "user-1", "token");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(
    calls.map(({ input, method }) => ({ input, method })),
    [
      { input: "https://discord.com/api/v10/channels/ticket-1/permissions/user-1", method: "PUT" },
      {
        input: "https://discord.com/api/v10/channels/ticket-1/permissions/user-1",
        method: "DELETE",
      },
    ],
  );
  assert.deepEqual(JSON.parse(calls[0]!.body!), {
    type: 1,
    allow: String((1n << 10n) | (1n << 11n) | (1n << 16n)),
    deny: "0",
  });
});

test("readTicketParticipantAccess returns only the selected member overwrite", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json({
      id: "ticket-1",
      name: "ticket",
      type: 0,
      parent_id: null,
      position: 0,
      permission_overwrites: [
        { id: "role-1", type: 0, allow: "1", deny: "0" },
        { id: "user-1", type: 1, allow: "2048", deny: "1024" },
      ],
    });
  try {
    assert.deepEqual(await readTicketParticipantAccess("ticket-1", "user-1", "token"), {
      allow: "2048",
      deny: "1024",
    });
    assert.equal(await readTicketParticipantAccess("ticket-1", "user-2", "token"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("addGuildMemberRole uses the Discord member-role endpoint", async () => {
  const calls: Array<{ input: string; method: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), method: init?.method ?? "GET" });
    return new Response(null, { status: 204 });
  };

  try {
    await addGuildMemberRole("guild-1", "user-1", "role-1", "bot-token");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [
    {
      input: "https://discord.com/api/v10/guilds/guild-1/members/user-1/roles/role-1",
      method: "PUT",
    },
  ]);
});

test("removeGuildMemberRole uses the Discord member-role endpoint", async () => {
  const calls: Array<{ input: string; method: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), method: init?.method ?? "GET" });
    return new Response(null, { status: 204 });
  };

  try {
    await removeGuildMemberRole("guild-1", "user-1", "role-1", "bot-token");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [
    {
      input: "https://discord.com/api/v10/guilds/guild-1/members/user-1/roles/role-1",
      method: "DELETE",
    },
  ]);
});

test("removeGuildMemberRole throws on Discord API failures", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("boom", { status: 500 });

  try {
    await assert.rejects(
      removeGuildMemberRole("guild-1", "user-1", "role-1", "bot-token"),
      /Discord API error: 500/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("leaveGuild removes the current bot from a guild", async () => {
  const calls: Array<{ input: string; method: string; authorization: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({
      input: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    return new Response(null, { status: 204 });
  };

  try {
    assert.equal(await leaveGuild("guild/1", "bot-token"), "left");
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [
    {
      input: "https://discord.com/api/v10/users/@me/guilds/guild%2F1",
      method: "DELETE",
      authorization: "Bot bot-token",
    },
  ]);
});

test("leaveGuild treats an absent guild as an idempotent success", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404 });

  try {
    assert.equal(await leaveGuild("guild-1", "bot-token"), "not-member");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("removeGuildMemberRole throws when Discord returns a non-ok response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    ({
      ok: false,
      status: 204,
      text: async () => "unexpected",
    }) as Response;

  try {
    await assert.rejects(
      removeGuildMemberRole("guild-1", "user-1", "role-1", "bot-token"),
      /Discord API error: 204 unexpected/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchGuildMember returns null when Discord returns 404", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("not found", { status: 404 });

  try {
    assert.equal(await fetchGuildMember("guild-1", "user-1", "bot-token"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("guildMemberHasRole checks fetched Discord member roles", async () => {
  const calls: Array<{ input: string; authorization: string | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({
      input: String(input),
      authorization: new Headers(init?.headers).get("Authorization"),
    });
    return Response.json({ roles: ["role-1", "role-2"] });
  };

  try {
    assert.equal(await guildMemberHasRole("guild-1", "user-1", "role-2", "bot-token"), true);
    assert.deepEqual(calls, [
      {
        input: "https://discord.com/api/v10/guilds/guild-1/members/user-1",
        authorization: "Bot bot-token",
      },
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("createTicketChannel posts a private guild channel with opener and support overwrites", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({ id: "ticket-channel-1" });
  }) as typeof fetch;

  try {
    await createTicketChannel(
      {
        guildId: "guild-1",
        name: "appeal-user-1",
        parentId: "category-1",
        botUserId: "bot-user-1",
        openerUserId: "user-1",
        supportRoleId: "role-1",
      },
      "bot-token",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [
    {
      url: "https://discord.com/api/v10/guilds/guild-1/channels",
      method: "POST",
      body: {
        name: "appeal-user-1",
        type: 0,
        parent_id: "category-1",
        permission_overwrites: [
          { id: "guild-1", type: 0, deny: "1024", allow: "0" },
          { id: "bot-user-1", type: 1, allow: "68608", deny: "0" },
          { id: "user-1", type: 1, allow: "68608", deny: "0" },
          { id: "role-1", type: 0, allow: "68608", deny: "0" },
        ],
      },
    },
  ]);
});

test("configureBotDefenseHoneypotChannel creates a warned trap hidden from trusted roles", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    return Response.json({ id: "honeypot-1", name: "do-not-post", type: 0 });
  };

  try {
    const channel = await configureBotDefenseHoneypotChannel(
      {
        guildId: "guild-1",
        botUserId: "bot-1",
        hiddenRoleIds: ["trusted-1", "trusted-1", "trusted-2"],
      },
      "bot-token",
    );

    assert.deepEqual(channel, { id: "honeypot-1", name: "do-not-post" });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [
    {
      url: "https://discord.com/api/v10/guilds/guild-1/channels",
      method: "POST",
      body: {
        name: "do-not-post",
        type: 0,
        topic:
          "HAF Bot security channel: legitimate members should not post here. Posting creates a staff-review flag.",
        permission_overwrites: [
          { id: "guild-1", type: 0, allow: "68608", deny: "0" },
          { id: "bot-1", type: 1, allow: "68608", deny: "0" },
          { id: "trusted-1", type: 0, allow: "0", deny: "1024" },
          { id: "trusted-2", type: 0, allow: "0", deny: "1024" },
        ],
      },
    },
  ]);
});

test("configureBotDefenseHoneypotChannel repairs an existing managed channel", async () => {
  const calls: Array<{ url: string; method: string }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? "GET" });
    return Response.json({ id: "honeypot-1", name: "do-not-post", type: 0 });
  };

  try {
    await configureBotDefenseHoneypotChannel(
      {
        guildId: "guild-1",
        botUserId: "bot-1",
        hiddenRoleIds: [],
        channelId: "honeypot-1",
      },
      "bot-token",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [
    {
      url: "https://discord.com/api/v10/channels/honeypot-1",
      method: "PATCH",
    },
  ]);
});

test("ensureForumTags patches missing forum lifecycle tags while preserving existing tags", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (method === "GET") {
      return Response.json({
        available_tags: [
          { id: "tag-existing", name: "TRIAGE", moderated: true, emoji_id: null, emoji_name: null },
          { id: "tag-new", name: "NEW", moderated: false, emoji_id: null, emoji_name: null },
        ],
      });
    }
    return Response.json({
      available_tags: [
        { id: "tag-existing", name: "TRIAGE", moderated: true, emoji_id: null, emoji_name: null },
        { id: "tag-new", name: "NEW", moderated: false, emoji_id: null, emoji_name: null },
        {
          id: "tag-completed",
          name: "COMPLETED",
          moderated: false,
          emoji_id: null,
          emoji_name: null,
        },
      ],
    });
  }) as typeof fetch;

  try {
    const tags = await ensureForumTags("forum-1", ["NEW", "COMPLETED"], "bot-token");
    assert.deepEqual(
      tags.map((tag) => tag.name),
      ["TRIAGE", "NEW", "COMPLETED"],
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [
    {
      url: "https://discord.com/api/v10/channels/forum-1",
      method: "GET",
      body: null,
    },
    {
      url: "https://discord.com/api/v10/channels/forum-1",
      method: "PATCH",
      body: {
        available_tags: [
          {
            id: "tag-existing",
            name: "TRIAGE",
            moderated: true,
            emoji_id: null,
            emoji_name: null,
          },
          {
            id: "tag-new",
            name: "NEW",
            moderated: false,
            emoji_id: null,
            emoji_name: null,
          },
          { name: "COMPLETED", moderated: false, emoji_id: null, emoji_name: null },
        ],
      },
    },
  ]);
});

test("uploadTranscriptToChannel includes the HTML transcript link in the payload when provided", async () => {
  const calls: Array<{ url: string; method: string; body: FormData | null }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body instanceof FormData ? init.body : null,
    });
    return Response.json({ id: "transcript-message-1", channel_id: "channel-1", content: "" });
  }) as typeof fetch;

  try {
    await uploadTranscriptToChannel("channel-1", "ticket-123.txt", "ticket body", "bot-token", {
      htmlTranscriptUrl: "https://runtime.example/transcripts/guild-1/channel-1",
      embeds: [
        {
          title: "Ticket Transcript",
          fields: [{ name: "Messages", value: "2", inline: true }],
        },
      ],
    });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://discord.com/api/v10/channels/channel-1/messages");
  assert.equal(calls[0]?.method, "POST");
  assert.deepEqual(JSON.parse(String(calls[0]?.body?.get("payload_json"))), {
    content: "HTML transcript: https://runtime.example/transcripts/guild-1/channel-1",
    embeds: [
      {
        title: "Ticket Transcript",
        fields: [{ name: "Messages", value: "2", inline: true }],
      },
    ],
    attachments: [{ id: 0, filename: "ticket-123.txt" }],
  });
  const transcriptFile = calls[0]?.body?.get("files[0]");
  assert.ok(transcriptFile instanceof File);
  assert.equal(await transcriptFile.text(), "ticket body");
});

test("createChannelMessageWithAttachments posts multipart message payload", async () => {
  const calls: Array<{
    url: string;
    method: string;
    authorization: string | null;
    body: FormData | null;
  }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      authorization: new Headers(init?.headers).get("Authorization"),
      body: init?.body instanceof FormData ? init.body : null,
    });
    return Response.json({ id: "message-1", channel_id: "channel-1", content: "" });
  }) as typeof fetch;

  try {
    await createChannelMessageWithAttachments(
      "channel-1",
      { content: "hello", allowed_mentions: { parse: ["users"] } },
      [{ filename: "proof.txt", contentType: "text/plain", data: new Blob(["proof body"]) }],
      "bot-token",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://discord.com/api/v10/channels/channel-1/messages");
  assert.equal(calls[0]?.method, "POST");
  assert.equal(calls[0]?.authorization, "Bot bot-token");
  assert.deepEqual(JSON.parse(String(calls[0]?.body?.get("payload_json"))), {
    content: "hello",
    allowed_mentions: { parse: ["users"] },
    attachments: [{ id: 0, filename: "proof.txt" }],
  });
  const file = calls[0]?.body?.get("files[0]");
  assert.ok(file instanceof File);
  assert.equal(file.name, "proof.txt");
  assert.equal(file.type, "text/plain");
  assert.equal(await file.text(), "proof body");
});

test("listBotGuilds maps Discord guild payload through the guild client", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify([{ id: "1", name: "Guild One" }]), { status: 200 });

  try {
    const guilds = await listBotGuilds("token");
    assert.deepEqual(guilds, [{ guildId: "1", name: "Guild One", icon: null }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discordGetJson retries one Discord 429 GET and returns the successful response", async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push(`${init?.method ?? "GET"} ${String(input)}`);
    if (calls.length === 1) {
      return Response.json({ retry_after: 0, global: true }, { status: 429 });
    }
    return Response.json({ ok: true });
  };

  try {
    assert.deepEqual(await discordGetJson("https://discord.example/resource", "bot-token"), {
      ok: true,
    });
    assert.deepEqual(calls, [
      "GET https://discord.example/resource",
      "GET https://discord.example/resource",
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("listGuildTicketResources retries repeated non-global Discord 429 responses", async () => {
  const originalFetch = globalThis.fetch;
  let channelRequests = 0;
  let roleRequests = 0;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/channels")) {
      channelRequests += 1;
      if (channelRequests < 3) {
        return Response.json({ retry_after: 0, global: false }, { status: 429 });
      }
      return Response.json([
        { id: "channel-1", name: "general", type: 0, parent_id: null, position: 0 },
      ]);
    }
    if (url.endsWith("/roles")) {
      roleRequests += 1;
      return Response.json([{ id: "role-1", name: "member", permissions: "0", position: 1 }]);
    }
    throw new Error(`Unexpected Discord request: ${url}`);
  };

  try {
    const resources = await listGuildTicketResources("guild-1", "bot-token");
    assert.deepEqual(
      resources.channels.map(({ id }) => id),
      ["channel-1"],
    );
    assert.deepEqual(
      resources.roles.map(({ id }) => id),
      ["role-1"],
    );
    assert.equal(channelRequests, 3);
    assert.equal(roleRequests, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discordGetJson does not retry beyond the bounded rate-limit wait budget", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({ retry_after: 1.25, global: false }, { status: 429 });
  };

  try {
    await assert.rejects(
      discordGetJson("https://discord.example/resource", "bot-token"),
      (error) => {
        assert.ok(error instanceof DiscordApiError);
        assert.equal(error.status, 429);
        assert.equal(error.retryAfterMs, 1250);
        assert.equal(requests, 1);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discordGetJson throws Discord rate-limit metadata after a repeated 429", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    return Response.json({ retry_after: requests < 3 ? 0 : 1.25, global: false }, { status: 429 });
  };

  try {
    await assert.rejects(
      discordGetJson("https://discord.example/resource", "bot-token"),
      (error) => {
        assert.ok(error instanceof DiscordApiError);
        assert.equal(error.status, 429);
        assert.equal(error.rateLimited, true);
        assert.equal(error.retryAfterMs, 1250);
        assert.equal(error.globalRateLimit, false);
        assert.match(error.message, /Discord API error: 429/);
        assert.equal(requests, 3);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discordOAuthGetJson retries one Discord 429 GET and returns the successful response", async () => {
  const originalFetch = globalThis.fetch;
  const authorizations: Array<string | null> = [];
  globalThis.fetch = async (_input, init) => {
    authorizations.push(new Headers(init?.headers).get("Authorization"));
    if (authorizations.length === 1) {
      return Response.json({ retry_after: 0, global: false }, { status: 429 });
    }
    return Response.json({ id: "user-guild" });
  };

  try {
    assert.deepEqual(
      await discordOAuthGetJson("https://discord.example/oauth-resource", "oauth-token"),
      {
        id: "user-guild",
      },
    );
    assert.deepEqual(authorizations, ["Bearer oauth-token", "Bearer oauth-token"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("editOriginalInteractionResponse retries a Discord webhook 429", async () => {
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => {
    requests += 1;
    if (requests === 1) {
      return Response.json({ retry_after: 0, global: false }, { status: 429 });
    }
    return Response.json({ id: "message-1", channel_id: "channel-1", content: "ok" });
  };

  try {
    const message = await editOriginalInteractionResponse("app-1", "interaction-token", {
      content: "ok",
    });
    assert.equal(message.id, "message-1");
    assert.equal(requests, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("isDiscordRateLimitError unwraps provider causes", () => {
  const providerError = new Error("provider failed", {
    cause: new DiscordApiError("rate limited", 429, "redacted"),
  });
  assert.equal(isDiscordRateLimitError(providerError), true);
});

test("createTicketChannel grants the bot and support role required private-thread permissions", async () => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")),
    });
    return new Response(JSON.stringify({ id: "new-channel" }), { status: 200 });
  };

  try {
    const created = await createTicketChannelFromChannels(
      {
        guildId: "guild-1",
        name: "support-001",
        parentId: "parent-1",
        botUserId: "bot-1",
        openerUserId: "user-1",
        supportRoleId: "role-1",
        anonymousEnabled: true,
      },
      "token",
    );

    assert.equal(created.id, "new-channel");
    assert.equal(calls[0]?.url, "https://discord.com/api/v10/guilds/guild-1/channels");
    const body = calls[0]?.body as {
      permission_overwrites?: Array<{ id: string; type: number; allow: string; deny: string }>;
    };
    assert.deepEqual(
      body.permission_overwrites?.find((overwrite) => overwrite.id === "bot-1"),
      {
        id: "bot-1",
        type: 1,
        allow: String((1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 36n) | (1n << 38n)),
        deny: "0",
      },
    );
    assert.deepEqual(
      body.permission_overwrites?.find((overwrite) => overwrite.id === "role-1"),
      {
        id: "role-1",
        type: 0,
        allow: String((1n << 10n) | (1n << 11n) | (1n << 16n) | (1n << 34n) | (1n << 38n)),
        deny: "0",
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
