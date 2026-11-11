import { afterEach } from "node:test";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";
import { interactionServices } from "./support/handler-services";
/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import worker from "./support/application";
import { DiscordApiError } from "../src/discord";
import { buildEphemeralMessage } from "../src/discord-interactions";
import { buildLfgCloseConfirmation } from "../src/lfg";
import { signSensitiveComponentId } from "../src/security/sensitive-component-ids";
import { createComponentIdSigner } from "../src/security/component-id-signer";
import { formatTimedRoleExpiry } from "../src/timed-roles";
import { isRecord } from "../src/unknown-parse";
import { createLegacyCommunityStoreDatabase } from "./helpers/legacy-community-store-d1";
import { createSqlitePlatformLinkStore } from "./support/sqlite/runtime/sqlite-platform-link-store";
import { SqliteD1Database } from "./support/sqlite-d1-database";

import type { RuntimeStores } from "../src/runtime/app-types";

const runtimeStoreFixtures = new Set<ReturnType<typeof createProductionRuntimeStores>>();
afterEach(() => {
  for (const fixture of runtimeStoreFixtures) fixture.close();
  runtimeStoreFixtures.clear();
});
function createTestRuntimeStores(): RuntimeStores {
  const fixture = createProductionRuntimeStores();
  runtimeStoreFixtures.add(fixture);
  return fixture.stores;
}

test("worker answers Discord PING interactions", async () => {
  const { publicKeyHex, request } = await createSignedInteractionRequest({ type: 1 });

  const response = await worker.fetch(
    request,
    createEnv({ DISCORD_PUBLIC_KEY: publicKeyHex }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 1 });
});

test("public interactions reject unsigned sensitive controls even with private migration settings", async () => {
  for (const customId of [
    "ticket:close:ticket-channel-1",
    "member_verification_verify:guild-1",
    "bot-defense:confirm:guild-1:user-1",
  ]) {
    const { publicKeyHex, request } = await createSignedInteractionRequest(
      {
        type: 3,
        guild_id: "guild-1",
        member: { user: { id: "user-1" }, roles: [] },
        data: { custom_id: customId },
      },
      { signComponents: false },
    );
    const env = Object.assign(createEnv({ DISCORD_PUBLIC_KEY: publicKeyHex }), {
      COMPONENT_ID_LEGACY_UNTIL: "2099-01-01T00:00:00Z",
      MEMBER_VERIFICATION_PANEL_LEGACY_UNTIL: "2099-01-01T00:00:00Z",
    });
    const response = await worker.fetch(request, env, {} as ExecutionContext);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      type: 4,
      data: { flags: 64, content: "This action is no longer available." },
    });
  }
});

test("worker rejects interactions with an invalid Discord signature", async () => {
  const { publicKeyHex, bodyText, timestamp } = await createSignedInteractionRequestBody({
    type: 1,
  });

  const response = await worker.fetch(
    new Request("https://worker.example/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": "00".repeat(64),
        "x-signature-timestamp": timestamp,
      },
      body: bodyText,
    }),
    createEnv({ DISCORD_PUBLIC_KEY: publicKeyHex }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Unauthorized");
});

test("worker rejects interactions with a stale Discord timestamp", async () => {
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    { type: 1 },
    { timestamp: String(Math.floor(Date.now() / 1000) - 3600) },
  );

  const response = await worker.fetch(
    request,
    createEnv({ DISCORD_PUBLIC_KEY: publicKeyHex }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 401);
  assert.equal(await response.text(), "Unauthorized");
});

test("worker rejects malformed Discord public key configuration before handling requests", async () => {
  await assert.rejects(
    worker.fetch(
      new Request("https://worker.example/health"),
      createEnv({ DISCORD_PUBLIC_KEY: `${"a".repeat(63)}y` }),
      {} as ExecutionContext,
    ),
    /DISCORD_PUBLIC_KEY must be a 64-character hex string/,
  );
});

test("worker returns a ticket modal for a signed open-ticket button click", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest({
    type: 3,
    guild_id: "guild-1",
    channel_id: "panel-channel-1",
    data: { custom_id: "ticket:open:appeals" },
    member: { user: { id: "user-1" } },
  });

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch(input, init) {
        storeCalls.push({
          input: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });

        if (String(input).includes("/ticket-panel?guildId=guild-1")) {
          return Response.json({
            guildId: "guild-1",
            panelId: "main",
            panelName: "Main panel",
            panelChannelId: "panel-channel-1",
            categoryChannelId: "category-1",
            transcriptChannelId: "transcript-1",
            panelMessageId: "panel-message-1",
            ticketTypes: [
              {
                id: "appeals",
                label: "Appeal",
                emoji: "🧾",
                buttonStyle: "primary",
                supportRoleId: "role-1",
                channelNamePrefix: "appeal",
                questions: [
                  {
                    id: "reason",
                    label: "Why are you opening this ticket?",
                    style: "paragraph",
                    placeholder: "Explain",
                    required: true,
                  },
                ],
                responseRules: [],
              },
            ],
          });
        }

        return Response.json({ ok: true });
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    type: 9,
    data: {
      custom_id: "ticket:open:main:appeals",
      title: "Appeal",
      components: [
        {
          type: 1,
          components: [
            {
              type: 4,
              custom_id: "reason",
              label: "Why are you opening this ticket?",
              style: 2,
              placeholder: "Explain",
              required: true,
            },
          ],
        },
      ],
    },
  });
  assert.deepEqual(storeCalls, [
    {
      input: "https://community-store/ticket-panel?guildId=guild-1",
      method: "GET",
      body: null,
    },
  ]);
});

test("worker rejects slash commands from members without guild admin permissions", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    createApplicationCommand({
      guildId: "guild-123",
      permissions: "0",
      subcommand: "add",
      emoji: "✅",
    }),
  );

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch(input, init) {
        storeCalls.push({
          input: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({ ok: true });
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage(
      "You need Administrator, the configured HAF admin role, or Manage Server when the owner allows it to use this command.",
    ),
  );
  assert.deepEqual(storeCalls, [
    {
      input: "https://community-store/guild-rbac/admin-role?guildId=guild-123",
      method: "GET",
      body: null,
    },
  ]);
});

test("worker accepts slash commands from configured app admin role", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest({
    ...createApplicationCommand({
      guildId: "guild-123",
      permissions: "0",
      subcommand: "add",
      emoji: "✅",
    }),
    member: {
      permissions: "0",
      roles: ["app-admin-role"],
      user: { id: "admin-1" },
    },
  });

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch(input, init) {
        storeCalls.push({
          input: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        if (String(input).includes("/guild-rbac/admin-role?guildId=guild-123")) {
          return Response.json({ guildAdminRoleId: "app-admin-role" });
        }
        return Response.json({ ok: true });
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), buildEphemeralMessage("Blocked ✅ in this server."));
  assert.deepEqual(storeCalls, [
    {
      input: "https://community-store/guild-rbac/admin-role?guildId=guild-123",
      method: "GET",
      body: null,
    },
    {
      input: "https://community-store/config",
      method: "GET",
      body: null,
    },
    {
      input: "https://community-store/guild-emoji",
      method: "POST",
      body: { guildId: "guild-123", emoji: "✅", action: "add" },
    },
    {
      input: "https://community-store/config",
      method: "GET",
      body: null,
    },
    {
      input:
        "https://community-store/guild-notification-channel?guildId=guild-123&feature=blocklist",
      method: "GET",
      body: null,
    },
  ]);
});

test("worker lists bot guild entitlements for authorized haf-admin users", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (url.endsWith("/users/@me/guilds")) {
      return Response.json([
        { id: "guild-2", name: "Alpha" },
        { id: "guild-1", name: "Zulu" },
      ]);
    }

    throw new Error(`Unexpected Discord call: ${url}`);
  }) as typeof fetch;

  try {
    const { publicKeyHex, request } = await createSignedInteractionRequest(
      createHafAdminCommand({
        interactionGuildId: "admin-guild",
        memberRoles: ["haf-admin-role"],
        subcommand: "list-guilds",
      }),
    );

    const response = await worker.fetch(
      request,
      createEnv({
        DISCORD_PUBLIC_KEY: publicKeyHex,
        HAF_ADMIN_GUILD_ID: "admin-guild",
        HAF_ADMIN_ROLE_ID: "haf-admin-role",
        guildEntitlementTiers: { "guild-1": "premium" },
      }),
      {} as ExecutionContext,
    );

    assert.equal(response.status, 200);
    assert.deepEqual(
      await response.json(),
      buildEphemeralMessage(
        ["Bot guild plans:", "- Alpha (`guild-2`): free", "- Zulu (`guild-1`): premium"].join("\n"),
      ),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("worker allows configured app admin role to close marketplace posts", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const post = createMarketplacePost();
  const { publicKeyHex, request } = await createSignedInteractionRequest({
    type: 3,
    guild_id: "guild-123",
    channel_id: "market-channel-1",
    data: { custom_id: "market:close:post-1" },
    member: {
      permissions: "0",
      roles: ["app-admin-role"],
      user: { id: "admin-1" },
    },
  });

  await withMockedFetch(
    async () => Response.json({ id: "message-1", channel_id: "market-channel-1", content: "" }),
    async () => {
      const response = await worker.fetch(
        request,
        createEnv({
          DISCORD_PUBLIC_KEY: publicKeyHex,
          moderationFetch(input, init) {
            storeCalls.push({
              input: String(input),
              method: init?.method ?? "GET",
              body: init?.body ? JSON.parse(String(init.body)) : null,
            });

            if (String(input).includes("/marketplace/post?guildId=guild-123&postId=post-1")) {
              return Response.json(post);
            }
            if (String(input).includes("/guild-rbac/admin-role?guildId=guild-123")) {
              return Response.json({ guildAdminRoleId: "app-admin-role" });
            }
            if (String(input) === "https://community-store/marketplace/post/close") {
              return Response.json({
                ...post,
                active: false,
                closedByUserId: "admin-1",
                closedAtMs: Date.now(),
              });
            }
            return Response.json({ ok: true });
          },
        }),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), buildEphemeralMessage("Marketplace post closed."));
    },
  );

  assert.deepEqual(
    storeCalls.map((call) => ({ input: call.input, method: call.method })),
    [
      {
        input: "https://community-store/marketplace/post?guildId=guild-123&postId=post-1",
        method: "GET",
      },
      {
        input: "https://community-store/guild-rbac/admin-role?guildId=guild-123",
        method: "GET",
      },
      {
        input: "https://community-store/marketplace/post?guildId=guild-123&postId=post-1",
        method: "GET",
      },
      {
        input: "https://community-store/marketplace/post?guildId=guild-123&postId=post-1",
        method: "GET",
      },
      { input: "https://community-store/marketplace/post/close", method: "POST" },
    ],
  );
  const marketplaceCloseBody = storeCalls[4]?.body as { closedAtMs: number };
  assert.deepEqual(storeCalls[4]?.body, {
    guildId: "guild-123",
    postId: "post-1",
    closedByUserId: "admin-1",
    closedAtMs: marketplaceCloseBody.closedAtMs,
  });
});

test("worker allows configured app admin role to request LFG close confirmation", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const post = createLfgPost();
  const config = {
    guildId: "guild-123",
    noticeChannelId: "lfg-channel-1",
    noticeMessageId: "notice-1",
    notificationRoleId: null,
    counterVoiceChannelId: null,
    counterDisplayFormat: "LFG ({count})",
    approvalFlowEnabled: false,
    approvalAuditChannelId: null,
    approvalVoiceCategoryId: null,
    expiryAction: "close",
    expiryDurationHours: 24,
    serverOptions: [{ id: "namalsk", label: "Namalsk", emoji: "🧊" }],
    updatedAtMs: 1,
  };
  const { publicKeyHex, request } = await createSignedInteractionRequest({
    type: 3,
    guild_id: "guild-123",
    channel_id: "lfg-channel-1",
    data: { custom_id: "lfg:close:post-1" },
    member: {
      permissions: "0",
      roles: ["app-admin-role"],
      user: { id: "admin-1" },
    },
  });

  await withMockedFetch(
    async () => Response.json({ id: "message-1", channel_id: "lfg-channel-1", content: "" }),
    async () => {
      const response = await worker.fetch(
        request,
        createEnv({
          DISCORD_PUBLIC_KEY: publicKeyHex,
          moderationFetch(input, init) {
            storeCalls.push({
              input: String(input),
              method: init?.method ?? "GET",
              body: init?.body ? JSON.parse(String(init.body)) : null,
            });

            if (String(input).includes("/lfg/post?guildId=guild-123&postId=post-1")) {
              return Response.json(post);
            }
            if (String(input).includes("/lfg/config?guildId=guild-123")) {
              return Response.json(config);
            }
            if (String(input).includes("/guild-rbac/admin-role?guildId=guild-123")) {
              return Response.json({ guildAdminRoleId: "app-admin-role" });
            }
            if (String(input) === "https://community-store/lfg/post/close") {
              return Response.json({
                ...post,
                active: false,
                closedByUserId: "admin-1",
                closedAtMs: Date.now(),
              });
            }
            return Response.json({ ok: true });
          },
        }),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 200);
      const confirmation = (await response.json()) as ReturnType<typeof buildLfgCloseConfirmation>;
      const signer = createComponentIdSigner({
        currentSecret: "component-id-signing-secret-for-production-tests",
      });
      for (const row of confirmation.data.components) {
        for (const button of row.components) {
          const verified = await signer.verify(button.custom_id, {
            guildId: "guild-123",
            actorUserId: "admin-1",
          });
          assert.ok(verified.ok);
          assert.ok(verified.expiresAtSeconds);
          assert.ok(Math.abs(verified.expiresAtSeconds * 1000 - Date.now() - 600_000) < 10_000);
          assert.equal(
            (
              await signer.verify(button.custom_id, {
                guildId: "guild-123",
                actorUserId: "another-admin",
              })
            ).ok,
            false,
          );
          button.custom_id = verified.customId;
        }
      }
      assert.deepEqual(confirmation, buildLfgCloseConfirmation(post));
    },
  );

  assert.deepEqual(
    storeCalls.map((call) => ({ input: call.input, method: call.method })),
    [
      { input: "https://community-store/lfg/post?guildId=guild-123&postId=post-1", method: "GET" },
      {
        input: "https://community-store/guild-rbac/admin-role?guildId=guild-123",
        method: "GET",
      },
    ],
  );
});

test("worker toggles the configured LFG notification role from the noticeboard", async () => {
  const roleCalls: Array<{ input: string; method: string }> = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest({
    type: 3,
    guild_id: "guild-123",
    channel_id: "lfg-channel-1",
    data: { custom_id: "lfg:toggle-alerts" },
    member: {
      permissions: "0",
      roles: [],
      user: { id: "user-1" },
    },
  });

  await withMockedFetch(
    async (input, init) => {
      roleCalls.push({ input: String(input), method: init?.method ?? "GET" });
      if (
        String(input) === "https://discord.com/api/v10/guilds/guild-123/members/user-1/roles/role-1"
      ) {
        return new Response(null, { status: 204 });
      }
      return Response.json({ ok: true });
    },
    async () => {
      const response = await worker.fetch(
        request,
        createEnv({
          DISCORD_PUBLIC_KEY: publicKeyHex,
          moderationFetch(input) {
            if (String(input).includes("/lfg/config?guildId=guild-123")) {
              return Response.json({
                guildId: "guild-123",
                noticeChannelId: "lfg-channel-1",
                noticeMessageId: "notice-1",
                notificationRoleId: "role-1",
                counterVoiceChannelId: null,
                counterDisplayFormat: "LFG ({count})",
                approvalFlowEnabled: false,
                approvalAuditChannelId: null,
                approvalVoiceCategoryId: null,
                expiryAction: "close",
                expiryDurationHours: 24,
                serverOptions: [{ id: "namalsk", label: "Namalsk", emoji: "🧊" }],
                updatedAtMs: 1,
              });
            }
            return Response.json(null);
          },
        }),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), buildEphemeralMessage("Joined <@&role-1>."));
    },
  );

  assert.deepEqual(roleCalls, [
    {
      input: "https://discord.com/api/v10/guilds/guild-123/members/user-1/roles/role-1",
      method: "PUT",
    },
  ]);
});

test("worker opens an LFG application modal when approval flow is enabled", async () => {
  const post = createLfgPost();
  const { publicKeyHex, request } = await createSignedInteractionRequest({
    type: 3,
    guild_id: "guild-123",
    channel_id: "lfg-channel-1",
    data: { custom_id: "lfg:interested:post-1" },
    member: {
      permissions: "0",
      roles: [],
      user: { id: "applicant-1", username: "applicant" },
    },
  });

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch(input) {
        if (String(input).includes("/lfg/post?guildId=guild-123&postId=post-1")) {
          return Response.json(post);
        }
        if (String(input).includes("/lfg/config?guildId=guild-123")) {
          return Response.json({
            guildId: "guild-123",
            noticeChannelId: "lfg-channel-1",
            noticeMessageId: "notice-1",
            notificationRoleId: null,
            counterVoiceChannelId: null,
            counterDisplayFormat: "LFG ({count})",
            approvalFlowEnabled: true,
            approvalAuditChannelId: "audit-channel-1",
            approvalVoiceCategoryId: "voice-category-1",
            expiryAction: "close",
            expiryDurationHours: 24,
            serverOptions: [{ id: "namalsk", label: "Namalsk", emoji: "🧊" }],
            updatedAtMs: 1,
          });
        }
        return Response.json(null);
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    type: number;
    data: {
      custom_id: string;
      title: string;
      components: Array<{ components: Array<{ custom_id: string }> }>;
    };
  };
  assert.equal(body.type, 9);
  assert.equal(body.data.custom_id, "lfg:apply-modal:post-1");
  assert.equal(body.data.title, "Apply to LFG Post");
  assert.equal(body.data.components[0]?.components[0]?.custom_id, "application_message");
});

test("worker denies an LFG review button replayed in another guild", async () => {
  const post = createLfgPost();
  const application = createLfgApplication();
  const storeCalls: string[] = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest({
    type: 3,
    guild_id: "guild-456",
    channel_id: "channel-456",
    data: { custom_id: "lfg:application-accept:guild-123:post-1:applicant-1" },
    member: {
      permissions: "8",
      roles: ["owner-role"],
      user: { id: "owner-1", username: "owner" },
    },
  });

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch(input) {
        storeCalls.push(String(input));
        if (String(input).includes("/lfg/post?guildId=guild-123&postId=post-1")) {
          return Response.json(post);
        }
        if (
          String(input).includes(
            "/lfg/application?guildId=guild-123&postId=post-1&applicantId=applicant-1",
          )
        ) {
          return Response.json(application);
        }
        return Response.json(null);
      },
    }),
    {} as ExecutionContext,
  );

  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("This action is not available in this server."),
  );
  assert.equal(storeCalls.length, 1);
  assert.equal(
    storeCalls.some((url) => url.includes("/update")),
    false,
  );
});

test("worker denies a Member Verification button replayed in another guild", async () => {
  let storeCalls = 0;
  const { publicKeyHex, request } = await createSignedInteractionRequest({
    type: 3,
    guild_id: "guild-456",
    channel_id: "channel-456",
    data: { custom_id: "member_verification_verify:guild-123" },
    member: {
      permissions: "8",
      roles: ["verified-role"],
      user: { id: "member-1", username: "member" },
    },
  });

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch() {
        storeCalls += 1;
        return Response.json(null);
      },
    }),
    {} as ExecutionContext,
  );

  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("This action is not available in this server."),
  );
  assert.equal(storeCalls, 0);
});

test("worker safely accepts an LFG application from the poster DM review button", async () => {
  const post = createLfgPost();
  const application = createLfgApplication();
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const discordCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest({
    type: 3,
    channel_id: "dm-channel-1",
    data: { custom_id: "lfg:application-accept:guild-123:post-1:applicant-1" },
    user: { id: "owner-1", username: "owner" },
  });

  await withMockedFetch(
    async (input, init) => {
      discordCalls.push({
        input: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (String(input).endsWith("/users/@me/channels")) {
        return Response.json({ id: "dm-channel-applicant" });
      }
      return Response.json({ id: "message-1", channel_id: "dm-channel-applicant", content: "" });
    },
    async () => {
      const response = await worker.fetch(
        request,
        createEnv({
          DISCORD_PUBLIC_KEY: publicKeyHex,
          moderationFetch(input, init) {
            storeCalls.push({
              input: String(input),
              method: init?.method ?? "GET",
              body: init?.body ? JSON.parse(String(init.body)) : null,
            });
            if (String(input).includes("/lfg/post?guildId=guild-123&postId=post-1")) {
              return Response.json(post);
            }
            if (
              String(input).includes(
                "/lfg/application?guildId=guild-123&postId=post-1&applicantId=applicant-1",
              )
            ) {
              return Response.json(application);
            }
            if (String(input).includes("/lfg/applications?guildId=guild-123&postId=post-1")) {
              return Response.json([]);
            }
            if (String(input).includes("/lfg/config?guildId=guild-123")) {
              return Response.json({
                guildId: "guild-123",
                noticeChannelId: "lfg-channel-1",
                noticeMessageId: "notice-1",
                notificationRoleId: null,
                counterVoiceChannelId: null,
                counterDisplayFormat: "LFG ({count})",
                approvalFlowEnabled: true,
                approvalAuditChannelId: "audit-channel-1",
                approvalVoiceCategoryId: "voice-category-1",
                expiryAction: "close",
                expiryDurationHours: 24,
                serverOptions: [{ id: "namalsk", label: "Namalsk", emoji: "🧊" }],
                updatedAtMs: 1,
              });
            }
            return Response.json({ ok: true });
          },
        }),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), buildEphemeralMessage("Application accepted."));
    },
  );

  const updateCall = storeCalls.find(
    (call) => call.input === "https://community-store/lfg/application/update",
  );
  assert.equal((updateCall?.body as { status?: string } | undefined)?.status, "accepted");
  assert.equal(
    (updateCall?.body as { reviewedByUserId?: string } | undefined)?.reviewedByUserId,
    "owner-1",
  );
  assert(discordCalls.some((call) => call.input.endsWith("/channels/audit-channel-1/messages")));
});

for (const testCase of [
  {
    name: "embedded Guild mismatch",
    customId: "lfg:application-accept:guild-999:post-1:applicant-1",
    actorId: "owner-1",
  },
  {
    name: "actor mismatch",
    customId: "lfg:application-accept:guild-123:post-1:applicant-1",
    actorId: "attacker-1",
  },
] as const) {
  test(`worker denies an LFG application DM with ${testCase.name}`, async () => {
    const post = createLfgPost();
    const application = createLfgApplication();
    const storeCalls: string[] = [];
    const { publicKeyHex, request } = await createSignedInteractionRequest({
      type: 3,
      channel_id: "dm-channel-1",
      data: { custom_id: testCase.customId },
      user: { id: testCase.actorId, username: "actor" },
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DISCORD_PUBLIC_KEY: publicKeyHex,
        moderationFetch(input) {
          storeCalls.push(String(input));
          if (String(input).includes("/lfg/post?guildId=")) return Response.json(post);
          if (String(input).includes("/lfg/application?guildId=")) {
            return Response.json(application);
          }
          return Response.json(null);
        },
      }),
      {} as ExecutionContext,
    );

    assert.deepEqual(
      await response.json(),
      buildEphemeralMessage("This action is not available in this server."),
    );
    assert.equal(storeCalls.length, 1);
    assert.equal(
      storeCalls.some((url) => url.includes("/update")),
      false,
    );
  });
}

test("worker opens a prefilled edit modal for the LFG post owner", async () => {
  const post = createLfgPost();
  const { publicKeyHex, request } = await createSignedInteractionRequest({
    type: 3,
    guild_id: "guild-123",
    channel_id: "lfg-channel-1",
    data: { custom_id: "lfg:edit:post-1" },
    member: {
      permissions: "0",
      roles: [],
      user: { id: "owner-1", username: "owner" },
    },
  });

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch(input) {
        if (String(input).includes("/lfg/post?guildId=guild-123&postId=post-1")) {
          return Response.json(post);
        }
        return Response.json(null);
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    type: number;
    data: {
      custom_id: string;
      title: string;
      components: Array<{ components: Array<{ value: string }> }>;
    };
  };
  assert.equal(body.type, 9);
  assert.equal(body.data.custom_id, "lfg:edit-modal:post-1");
  assert.equal(body.data.title, "Edit LFG Post");
  assert.equal(body.data.components[0]?.components[0]?.value, "namalsk");
  assert.equal(body.data.components[1]?.components[0]?.value, "Tonight");
  assert.equal(body.data.components[2]?.components[0]?.value, "Duo partner");
  assert.equal(body.data.components[3]?.components[0]?.value, "Bring meds");
});

test("worker updates the same LFG post when the owner submits the edit modal", async () => {
  const post = createLfgPost();
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest({
    type: 5,
    guild_id: "guild-123",
    channel_id: "lfg-channel-1",
    data: {
      custom_id: "lfg:edit-modal:post-1",
      components: [
        { components: [{ custom_id: "server_id", value: "chernarus" }] },
        { components: [{ custom_id: "when_play", value: "Tomorrow" }] },
        { components: [{ custom_id: "looking_for", value: "Full squad" }] },
        { components: [{ custom_id: "extra_info", value: "Bring ammo" }] },
      ],
    },
    member: {
      permissions: "0",
      roles: [],
      user: { id: "owner-1", username: "owner" },
    },
  });

  await withMockedFetch(
    async () => Response.json({ id: "message-1", channel_id: "lfg-channel-1", content: "" }),
    async () => {
      const response = await worker.fetch(
        request,
        createEnv({
          DISCORD_PUBLIC_KEY: publicKeyHex,
          moderationFetch(input, init) {
            storeCalls.push({
              input: String(input),
              method: init?.method ?? "GET",
              body: init?.body ? JSON.parse(String(init.body)) : null,
            });
            if (String(input).includes("/lfg/post?guildId=guild-123&postId=post-1")) {
              return Response.json(post);
            }
            if (String(input).includes("/lfg/config?guildId=guild-123")) {
              return Response.json({
                guildId: "guild-123",
                noticeChannelId: "lfg-channel-1",
                noticeMessageId: "notice-1",
                notificationRoleId: null,
                counterVoiceChannelId: null,
                counterDisplayFormat: "LFG ({count})",
                approvalFlowEnabled: false,
                approvalAuditChannelId: null,
                approvalVoiceCategoryId: null,
                expiryAction: "close",
                expiryDurationHours: 24,
                serverOptions: [{ id: "namalsk", label: "Namalsk", emoji: "🧊" }],
                updatedAtMs: 1,
              });
            }
            if (String(input) === "https://community-store/lfg/post/update") {
              return Response.json({
                ...post,
                serverId: "chernarus",
                serverLabel: "Chernarus",
                whenPlay: "Tomorrow",
                lookingFor: "Full squad",
                extraInfo: "Bring ammo",
              });
            }
            return Response.json({ ok: true });
          },
        }),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), buildEphemeralMessage("LFG post updated."));
    },
  );

  assert.deepEqual(
    storeCalls.map((call) => ({ input: call.input, method: call.method })),
    [
      { input: "https://community-store/lfg/post?guildId=guild-123&postId=post-1", method: "GET" },
      { input: "https://community-store/lfg/post?guildId=guild-123&postId=post-1", method: "GET" },
      { input: "https://community-store/lfg/config?guildId=guild-123", method: "GET" },
      { input: "https://community-store/lfg/post/update", method: "POST" },
    ],
  );
});

test("worker safely renews an LFG post from a DM reminder button", async () => {
  const post = createLfgPost();
  const { publicKeyHex, request } = await createSignedInteractionRequest({
    type: 3,
    channel_id: "dm-channel-1",
    data: { custom_id: "lfg:renew:guild-123:post-1" },
    user: { id: "owner-1", username: "owner" },
  });

  await withMockedFetch(
    async () => Response.json({ id: "message-1", channel_id: "lfg-channel-1", content: "" }),
    async () => {
      const response = await worker.fetch(
        request,
        createEnv({
          DISCORD_PUBLIC_KEY: publicKeyHex,
          moderationFetch(input, init) {
            if (String(input).includes("/lfg/post?guildId=guild-123&postId=post-1")) {
              return Response.json(post);
            }
            if (String(input).includes("/lfg/config?guildId=guild-123")) {
              return Response.json({
                guildId: "guild-123",
                noticeChannelId: "lfg-channel-1",
                noticeMessageId: "notice-1",
                notificationRoleId: null,
                counterVoiceChannelId: null,
                counterDisplayFormat: "LFG ({count})",
                approvalFlowEnabled: false,
                approvalAuditChannelId: null,
                approvalVoiceCategoryId: null,
                expiryAction: "close",
                expiryDurationHours: 24,
                serverOptions: [{ id: "namalsk", label: "Namalsk", emoji: "🧊" }],
                updatedAtMs: 1,
              });
            }
            if (String(input) === "https://community-store/lfg/post/update") {
              const body = init?.body ? JSON.parse(String(init.body)) : null;
              return Response.json({ ...post, ...body });
            }
            return Response.json({ ok: true });
          },
        }),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), buildEphemeralMessage("LFG post renewed."));
    },
  );
});

test("worker denies LFG renewal from a DM when the actor does not own the loaded post", async () => {
  const post = createLfgPost();
  const storeCalls: string[] = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest({
    type: 3,
    channel_id: "dm-channel-1",
    data: { custom_id: "lfg:renew:guild-123:post-1" },
    user: { id: "attacker-1", username: "attacker" },
  });

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch(input) {
        storeCalls.push(String(input));
        if (String(input).includes("/lfg/post?guildId=guild-123&postId=post-1")) {
          return Response.json(post);
        }
        return Response.json(null);
      },
    }),
    {} as ExecutionContext,
  );

  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("This action is not available in this server."),
  );
  assert.equal(storeCalls.length, 1);
  assert.equal(
    storeCalls.some((url) => url.includes("/update")),
    false,
  );
});

test("worker forwards valid guild admin add and remove slash commands to the moderation store", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const blockedEmojis = new Set<string>();
  const env = createEnv({
    moderationFetch(input, init) {
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      storeCalls.push({
        input: String(input),
        method,
        body,
      });

      if (method === "GET") {
        return Response.json({
          emojis: [],
          guilds: blockedEmojis.size
            ? {
                "guild-123": {
                  enabled: true,
                  emojis: [...blockedEmojis],
                },
              }
            : {},
          botUserId: "",
        });
      }

      if (isRecord(body) && "action" in body && "emoji" in body) {
        if (body.action === "add") {
          blockedEmojis.add(String(body.emoji));
        } else if (body.action === "remove") {
          blockedEmojis.delete(String(body.emoji));
        }
      }

      return Response.json({ ok: true });
    },
  });

  const addRequest = await createSignedInteractionRequest(
    createApplicationCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "add",
      emoji: "✅",
    }),
  );
  env.DISCORD_PUBLIC_KEY = addRequest.publicKeyHex;

  const addResponse = await worker.fetch(addRequest.request, env, {} as ExecutionContext);

  const removeRequest = await createSignedInteractionRequest(
    createApplicationCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "remove",
      emoji: "✅",
    }),
  );
  env.DISCORD_PUBLIC_KEY = removeRequest.publicKeyHex;

  const removeResponse = await worker.fetch(removeRequest.request, env, {} as ExecutionContext);

  assert.equal(addResponse.status, 200);
  assert.deepEqual(await addResponse.json(), buildEphemeralMessage("Blocked ✅ in this server."));
  assert.equal(removeResponse.status, 200);
  assert.deepEqual(
    await removeResponse.json(),
    buildEphemeralMessage("Unblocked ✅ in this server."),
  );
  assert.deepEqual(storeCalls, [
    {
      input: "https://community-store/config",
      method: "GET",
      body: null,
    },
    {
      input: "https://community-store/guild-emoji",
      method: "POST",
      body: { guildId: "guild-123", emoji: "✅", action: "add" },
    },
    {
      input: "https://community-store/config",
      method: "GET",
      body: null,
    },
    {
      input:
        "https://community-store/guild-notification-channel?guildId=guild-123&feature=blocklist",
      method: "GET",
      body: null,
    },
    {
      input: "https://community-store/guild-emoji",
      method: "POST",
      body: { guildId: "guild-123", emoji: "✅", action: "remove" },
    },
    {
      input: "https://community-store/config",
      method: "GET",
      body: null,
    },
    {
      input:
        "https://community-store/guild-notification-channel?guildId=guild-123&feature=blocklist",
      method: "GET",
      body: null,
    },
  ]);
});

test("worker posts a moderation update message for slash blocklist changes when a log channel is configured", async () => {
  const discordCalls: Array<{
    input: string;
    method: string | undefined;
    body: { embeds?: Array<{ timestamp?: string }> };
  }> = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    createApplicationCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "add",
      emoji: "✅",
    }),
  );

  await withMockedFetch(
    async (input, init) => {
      discordCalls.push({
        input: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });

      return Response.json({ id: "message-1", channel_id: "log-channel-1", content: "ok" });
    },
    async () => {
      const response = await worker.fetch(
        request,
        createEnv({
          DISCORD_PUBLIC_KEY: publicKeyHex,
          moderationFetch(input, init) {
            const method = init?.method ?? "GET";

            if (String(input).includes("/guild-notification-channel?guildId=guild-123")) {
              return Response.json({ notificationChannelId: "log-channel-1" });
            }

            if (method === "GET") {
              return Response.json({
                emojis: [],
                guilds: {},
                botUserId: "",
              });
            }

            return Response.json({ ok: true });
          },
        }),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), buildEphemeralMessage("Blocked ✅ in this server."));
    },
  );

  assert.deepEqual(discordCalls, [
    {
      input: "https://discord.com/api/v10/channels/log-channel-1/messages",
      method: "POST",
      body: {
        embeds: [
          {
            title: "🧱 Blocklist Update",
            color: 15548997,
            fields: [
              { name: "Actor", value: "<@admin-1>\nID: admin-1", inline: false },
              { name: "Action", value: "Added", inline: false },
              { name: "Emoji", value: "✅", inline: false },
            ],
            footer: { text: "hafbot.xyz" },
            timestamp: discordCalls[0]?.body.embeds?.[0]?.timestamp,
          },
        ],
        allowed_mentions: { parse: [] },
      },
    },
  ]);
});

test("worker adds each emoji from one slash blocklist add input", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    createApplicationCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "add",
      emoji: "✅🚫",
    }),
  );

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      guildEntitlementTier: "premium",
      moderationFetch(input, init) {
        storeCalls.push({
          input: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });

        return Response.json({
          emojis: [],
          guilds: {},
          botUserId: "",
        });
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), buildEphemeralMessage("Blocked ✅🚫 in this server."));
  assert.deepEqual(
    storeCalls.filter((call) => call.method === "POST"),
    [
      {
        input: "https://community-store/guild-emoji",
        method: "POST",
        body: { guildId: "guild-123", emoji: "✅", action: "add" },
      },
      {
        input: "https://community-store/guild-emoji",
        method: "POST",
        body: { guildId: "guild-123", emoji: "🚫", action: "add" },
      },
    ],
  );
});

test("worker returns duplicate add feedback without mutating the store", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    createApplicationCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "add",
      emoji: "✅",
    }),
  );

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch(input, init) {
        storeCalls.push({
          input: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({
          emojis: [],
          guilds: {
            "guild-123": {
              enabled: true,
              emojis: ["✅"],
            },
          },
          botUserId: "",
        });
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("✅ is already blocked in this server."),
  );
  assert.deepEqual(storeCalls, [
    {
      input: "https://community-store/config",
      method: "GET",
      body: null,
    },
  ]);
});

test("worker returns missing remove feedback without mutating the store", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    createApplicationCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "remove",
      emoji: "✅",
    }),
  );

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch(input, init) {
        storeCalls.push({
          input: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({
          emojis: [],
          guilds: {},
          botUserId: "",
        });
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("✅ is not currently blocked in this server."),
  );
  assert.deepEqual(storeCalls, [
    {
      input: "https://community-store/config",
      method: "GET",
      body: null,
    },
  ]);
});

test("worker normalizes custom emoji aliases before duplicate and missing checks", async () => {
  const duplicateCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const duplicateRequest = await createSignedInteractionRequest(
    createApplicationCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "add",
      emoji: ":blobcat:",
    }),
  );

  const duplicateResponse = await worker.fetch(
    duplicateRequest.request,
    createEnv({
      DISCORD_PUBLIC_KEY: duplicateRequest.publicKeyHex,
      moderationFetch(input, init) {
        duplicateCalls.push({
          input: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({
          emojis: [],
          guilds: {
            "guild-123": {
              enabled: true,
              emojis: ["blobcat"],
            },
          },
          botUserId: "",
        });
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(duplicateResponse.status, 200);
  assert.deepEqual(
    await duplicateResponse.json(),
    buildEphemeralMessage(":blobcat: is already blocked in this server."),
  );
  assert.deepEqual(duplicateCalls, [
    {
      input: "https://community-store/config",
      method: "GET",
      body: null,
    },
  ]);

  const missingCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const missingRequest = await createSignedInteractionRequest(
    createApplicationCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "remove",
      emoji: ":blobcat:",
    }),
  );

  const missingResponse = await worker.fetch(
    missingRequest.request,
    createEnv({
      DISCORD_PUBLIC_KEY: missingRequest.publicKeyHex,
      moderationFetch(input, init) {
        missingCalls.push({
          input: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({
          emojis: [],
          guilds: {},
          botUserId: "",
        });
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(missingResponse.status, 200);
  assert.deepEqual(
    await missingResponse.json(),
    buildEphemeralMessage(":blobcat: is not currently blocked in this server."),
  );
  assert.deepEqual(missingCalls, [
    {
      input: "https://community-store/config",
      method: "GET",
      body: null,
    },
  ]);
});

test("worker returns an ephemeral failure when moderation store forwarding throws", async () => {
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    createApplicationCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "add",
      emoji: "✅",
    }),
  );

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch() {
        throw new Error("store unavailable");
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("Failed to update the server blocklist."),
  );
});

test("worker returns the empty state for /blocklist list when no emojis are blocked", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    createApplicationCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "list",
    }),
  );

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch(input, init) {
        storeCalls.push({
          input: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({
          emojis: [],
          guilds: {},
          botUserId: "",
        });
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("No emojis are blocked in this server."),
  );
  assert.deepEqual(storeCalls, [
    {
      input: "https://community-store/config",
      method: "GET",
      body: null,
    },
  ]);
});

test("worker returns the current server blocklist for /blocklist list", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    createApplicationCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "list",
    }),
  );

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch(input, init) {
        storeCalls.push({
          input: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json({
          emojis: [],
          guilds: {
            "guild-123": {
              enabled: true,
              emojis: ["✅", "🍎"],
            },
          },
          botUserId: "",
        });
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("Blocked emojis in this server:\n- ✅\n- 🍎"),
  );
  assert.deepEqual(storeCalls, [
    {
      input: "https://community-store/config",
      method: "GET",
      body: null,
    },
  ]);
});

test("worker defers slash command responses when command work is still pending", async () => {
  let resolveStoreRead: ((response: Response) => void) | undefined;
  const waitUntilPromises: Promise<unknown>[] = [];
  const discordCalls: Array<{ input: string; method: string | undefined; body: unknown }> = [];
  const interaction = {
    ...createApplicationCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "list",
    }),
    application_id: "app-123",
    token: "interaction-token",
  };
  const { publicKeyHex, request } = await createSignedInteractionRequest(interaction);

  await withMockedFetch(
    async (input, init) => {
      discordCalls.push({
        input: String(input),
        method: init?.method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      return Response.json({ id: "message-1" });
    },
    async () => {
      const response = await worker.fetch(
        request,
        createEnv({
          DISCORD_PUBLIC_KEY: publicKeyHex,
          moderationFetch() {
            return new Promise<Response>((resolve) => {
              resolveStoreRead = resolve;
            }) as unknown as Response;
          },
        }),
        {
          waitUntil(promise) {
            waitUntilPromises.push(promise);
          },
        } as ExecutionContext,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
      assert.equal(discordCalls.length, 0);

      resolveStoreRead?.(
        Response.json({
          emojis: [],
          guilds: {
            "guild-123": {
              enabled: true,
              emojis: ["✅"],
            },
          },
          botUserId: "bot-user-id",
        }),
      );
      await Promise.all(waitUntilPromises);
    },
  );

  assert.deepEqual(discordCalls, [
    {
      input: "https://discord.com/api/v10/webhooks/app-123/interaction-token/messages/@original",
      method: "PATCH",
      body: { content: "Blocked emojis in this server:\n- ✅", flags: 64 },
    },
  ]);
});

test("worker returns a Platform Link limit message for the 101st manual free-tier link", async () => {
  const database = new SqliteD1Database();
  const platformLinkStore = createSqlitePlatformLinkStore(database as unknown as D1Database);
  await platformLinkStore.upsertPlatformLinkConfig({
    guildId: "guild-123",
    platform: "steam",
    linkedRoleId: null,
    logChannelId: null,
    gameAppIds: [],
    panelTitle: "Link Steam",
    panelDescription: "Link Steam",
    panelButtonLabel: "Link Steam",
    panelButtonStyle: "Primary",
    panelColor: 0x5865f2,
    allowRelink: true,
    allowMultipleLinks: true,
    requireRelinkOnRejoin: false,
    whoisFields: [],
    customLinks: [],
    panelChannelId: null,
    panelMessageId: null,
    updatedAtMs: 1,
  });
  for (let index = 0; index < 100; index += 1) {
    await platformLinkStore.upsertPlatformLink({
      guildId: "guild-123",
      userId: `existing-user-${index}`,
      platform: "steam",
      platformId: `existing-steam-${index}`,
      linkedAtMs: 1,
      manual: false,
      actionedByUserId: null,
      metadataJson: null,
      active: true,
    });
  }
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    createSteamManualLinkCommand({
      guildId: "guild-123",
      permissions: "8",
      userId: "user-11",
      steamId64: "76561198000000011",
    }),
  );

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      appDb: database as unknown as D1Database,
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage(
      "This Guild has reached its plan limit of 100 Platform Links. Upgrade for Unlimited Platform Links.",
    ),
  );
  assert.equal((await platformLinkStore.listPlatformLinks("guild-123")).length, 100);
});

test("worker ignores legacy top-level blocklist entries for /blocklist list", async () => {
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    createApplicationCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "list",
    }),
  );

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch() {
        return Response.json({
          emojis: ["🏳️‍🌈", "🍎"],
          guilds: {},
          botUserId: "",
        });
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("No emojis are blocked in this server."),
  );
});

test("worker truncates oversized /blocklist list responses to Discord's message limit", async () => {
  const oversizedGuildBlocklist = Array.from(
    { length: 400 },
    (_, index) => `custom-emoji-${String(index).padStart(3, "0")}`,
  );
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    createApplicationCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "list",
    }),
  );

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      moderationFetch() {
        return Response.json({
          emojis: [],
          guilds: {
            "guild-123": {
              enabled: true,
              emojis: oversizedGuildBlocklist,
            },
          },
          botUserId: "",
        });
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  const body = (await response.json()) as ReturnType<typeof buildEphemeralMessage>;
  assert.deepEqual(body.type, 4);
  assert.equal(body.data.flags, 64);
  assert.ok(body.data.content.startsWith("Blocked emojis in this server:\n- custom-emoji-000"));
  assert.ok(body.data.content.includes("\n...and "));
  assert.ok(body.data.content.length <= 2000);
});

test("worker assigns a timed role for a valid guild admin command", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];

  await withMockedFetch(
    async () => new Response(null, { status: 204 }),
    async () => {
      const { publicKeyHex, request } = await createSignedInteractionRequest(
        createTimedRoleCommand({
          guildId: "guild-123",
          permissions: "8",
          subcommand: "add",
          userId: "user-1",
          roleId: "role-1",
          duration: "1w",
        }),
      );

      const response = await worker.fetch(
        request,
        createEnv({
          DISCORD_PUBLIC_KEY: publicKeyHex,
          guildEntitlementTier: "premium",
          moderationFetch(input, init) {
            storeCalls.push({
              input: String(input),
              method: init?.method ?? "GET",
              body: init?.body ? JSON.parse(String(init.body)) : null,
            });
            return Response.json({ ok: true });
          },
        }),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 200);
      const expiresAtMs =
        storeCalls[0] && isRecord(storeCalls[0].body)
          ? (storeCalls[0].body as { expiresAtMs: number }).expiresAtMs
          : undefined;
      assert.deepEqual(
        await response.json(),
        buildEphemeralMessage(
          `Assigned <@&role-1> to <@user-1> for 1w (${formatTimedRoleExpiry(expiresAtMs as number)}).`,
        ),
      );
    },
  );

  assert.equal(storeCalls[0]?.input, "https://community-store/timed-role");
  assert.equal(storeCalls[0]?.method, "POST");
  assert.deepEqual(storeCalls[0]?.body, {
    guildId: "guild-123",
    userId: "user-1",
    roleId: "role-1",
    targetDisplayName: null,
    durationInput: "1w",
    expiresAtMs:
      storeCalls[0] && isRecord(storeCalls[0].body)
        ? (storeCalls[0].body as { expiresAtMs: number }).expiresAtMs
        : undefined,
  });
  assert.equal(typeof (storeCalls[0]?.body as { expiresAtMs?: unknown })?.expiresAtMs, "number");
});

test("worker rejects invalid timed-role durations", async () => {
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    createTimedRoleCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "add",
      userId: "user-1",
      roleId: "role-1",
      duration: "tomorrow",
    }),
  );

  const response = await worker.fetch(
    request,
    createEnv({ DISCORD_PUBLIC_KEY: publicKeyHex, guildEntitlementTier: "premium" }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("Invalid duration. Use values like 1h, 1w, or 1m."),
  );
});

test("worker rolls back timed role persistence when Discord role assignment fails", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];

  await withMockedFetch(
    async () => new Response("discord unavailable", { status: 500 }),
    async () => {
      const { publicKeyHex, request } = await createSignedInteractionRequest(
        createTimedRoleCommand({
          guildId: "guild-123",
          permissions: "8",
          subcommand: "add",
          userId: "user-1",
          roleId: "role-1",
          duration: "1w",
        }),
      );

      const response = await worker.fetch(
        request,
        createEnv({
          DISCORD_PUBLIC_KEY: publicKeyHex,
          guildEntitlementTier: "premium",
          moderationFetch(input, init) {
            storeCalls.push({
              input: String(input),
              method: init?.method ?? "GET",
              body: init?.body ? JSON.parse(String(init.body)) : null,
            });
            return Response.json({ ok: true });
          },
        }),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(
        await response.json(),
        buildEphemeralMessage(
          "Failed to assign the timed role because Discord is currently unavailable.",
        ),
      );
    },
  );

  assert.deepEqual(
    storeCalls.map((call) => ({ input: call.input, method: call.method })),
    [
      { input: "https://community-store/timed-role", method: "POST" },
      { input: "https://community-store/timed-role/remove", method: "POST" },
    ],
  );
});

test("worker explains timed role permission failures from Discord", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];

  await withMockedFetch(
    async () => new Response("Missing Permissions", { status: 403 }),
    async () => {
      const { publicKeyHex, request } = await createSignedInteractionRequest(
        createTimedRoleCommand({
          guildId: "guild-123",
          permissions: "8",
          subcommand: "add",
          userId: "user-1",
          roleId: "role-1",
          duration: "1w",
        }),
      );

      const response = await worker.fetch(
        request,
        createEnv({
          DISCORD_PUBLIC_KEY: publicKeyHex,
          guildEntitlementTier: "premium",
          moderationFetch(input, init) {
            storeCalls.push({
              input: String(input),
              method: init?.method ?? "GET",
              body: init?.body ? JSON.parse(String(init.body)) : null,
            });
            return Response.json({ ok: true });
          },
        }),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(
        await response.json(),
        buildEphemeralMessage(
          "Failed to assign the timed role. Ensure the bot has Manage Roles and that its highest role is above the target role.",
        ),
      );
    },
  );

  assert.deepEqual(
    storeCalls.map((call) => ({ input: call.input, method: call.method })),
    [
      { input: "https://community-store/timed-role", method: "POST" },
      { input: "https://community-store/timed-role/remove", method: "POST" },
    ],
  );
});

test("worker reports rollback failure when timed role cleanup cannot be persisted", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];

  await withMockedFetch(
    async () => new Response("discord unavailable", { status: 500 }),
    async () => {
      const { publicKeyHex, request } = await createSignedInteractionRequest(
        createTimedRoleCommand({
          guildId: "guild-123",
          permissions: "8",
          subcommand: "add",
          userId: "user-1",
          roleId: "role-1",
          duration: "1w",
        }),
      );

      let postCount = 0;
      const response = await worker.fetch(
        request,
        createEnv({
          DISCORD_PUBLIC_KEY: publicKeyHex,
          guildEntitlementTier: "premium",
          moderationFetch(input, init) {
            const method = init?.method ?? "GET";
            const body = init?.body ? JSON.parse(String(init.body)) : null;
            storeCalls.push({
              input: String(input),
              method,
              body,
            });
            postCount += method === "POST" ? 1 : 0;

            if (postCount === 2) {
              return new Response("rollback failed", { status: 500 });
            }

            return Response.json({ ok: true });
          },
        }),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(
        await response.json(),
        buildEphemeralMessage("Failed to assign the timed role, and rollback failed."),
      );
    },
  );

  assert.deepEqual(
    storeCalls.map((call) => ({ input: call.input, method: call.method })),
    [
      { input: "https://community-store/timed-role", method: "POST" },
      { input: "https://community-store/timed-role/remove", method: "POST" },
    ],
  );
});

test("worker removes an active timed role assignment", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const discordCalls: Array<{
    input: string;
    method: string | undefined;
    body: { embeds?: Array<{ timestamp?: string }> } | null;
  }> = [];

  await withMockedFetch(
    async (input, init) => {
      const method = init?.method;
      discordCalls.push({
        input: String(input),
        method,
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (method === "POST") {
        return Response.json({ id: "message-1", channel_id: "log-channel-1", content: "ok" });
      }
      return new Response(null, { status: 204 });
    },
    async () => {
      const { publicKeyHex, request } = await createSignedInteractionRequest(
        createTimedRoleCommand({
          guildId: "guild-123",
          permissions: "8",
          subcommand: "remove",
          userId: "user-1",
          roleId: "role-1",
        }),
      );

      const response = await worker.fetch(
        request,
        createEnv({
          DISCORD_PUBLIC_KEY: publicKeyHex,
          guildEntitlementTier: "premium",
          moderationFetch(input, init) {
            storeCalls.push({
              input: String(input),
              method: init?.method ?? "GET",
              body: init?.body ? JSON.parse(String(init.body)) : null,
            });

            if (String(input).includes("/guild-notification-channel?guildId=guild-123")) {
              return Response.json({ notificationChannelId: "log-channel-1" });
            }

            if ((init?.method ?? "GET") === "GET") {
              return Response.json([
                {
                  guildId: "guild-123",
                  userId: "user-1",
                  roleId: "role-1",
                  durationInput: "1w",
                  expiresAtMs: 1_700_604_800_000,
                },
              ]);
            }

            return Response.json({ ok: true });
          },
        }),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(
        await response.json(),
        buildEphemeralMessage("Removed <@&role-1> from <@user-1>."),
      );
    },
  );

  assert.deepEqual(
    storeCalls.map((call) => ({ input: call.input, method: call.method })),
    [
      {
        input: "https://community-store/timed-roles?guildId=guild-123",
        method: "GET",
      },
      {
        input: "https://community-store/timed-role/remove",
        method: "POST",
      },
      {
        input:
          "https://community-store/guild-notification-channel?guildId=guild-123&feature=timed-role",
        method: "GET",
      },
    ],
  );
  assert.deepEqual(discordCalls, [
    {
      input: "https://discord.com/api/v10/guilds/guild-123/members/user-1/roles/role-1",
      method: "DELETE",
      body: null,
    },
    {
      input: "https://discord.com/api/v10/channels/log-channel-1/messages",
      method: "POST",
      body: {
        embeds: [
          {
            title: "⏱ Timed Role Update",
            color: 16705372,
            fields: [
              { name: "Actor", value: "<@admin-1>\nID: admin-1", inline: false },
              { name: "Target Member", value: "<@user-1>\nID: user-1", inline: false },
              { name: "Role", value: "<@&role-1>", inline: false },
              { name: "Duration", value: "1w", inline: false },
              { name: "Expires", value: "<t:1700604800:R>", inline: false },
            ],
            footer: { text: "hafbot.xyz" },
            timestamp: discordCalls[1]?.body?.embeds?.[0]?.timestamp,
          },
        ],
        allowed_mentions: { parse: [] },
      },
    },
  ]);
});

test("worker returns a no-op response when the timed role assignment is not active", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const discordCalls: Array<{ input: string; method: string | undefined }> = [];

  await withMockedFetch(
    async (input, init) => {
      discordCalls.push({ input: String(input), method: init?.method });
      return new Response(null, { status: 204 });
    },
    async () => {
      const { publicKeyHex, request } = await createSignedInteractionRequest(
        createTimedRoleCommand({
          guildId: "guild-123",
          permissions: "8",
          subcommand: "remove",
          userId: "user-1",
          roleId: "role-1",
        }),
      );

      const response = await worker.fetch(
        request,
        createEnv({
          DISCORD_PUBLIC_KEY: publicKeyHex,
          guildEntitlementTier: "premium",
          moderationFetch(input, init) {
            storeCalls.push({
              input: String(input),
              method: init?.method ?? "GET",
              body: init?.body ? JSON.parse(String(init.body)) : null,
            });
            return Response.json([]);
          },
        }),
        {} as ExecutionContext,
      );

      assert.equal(response.status, 200);
      assert.deepEqual(
        await response.json(),
        buildEphemeralMessage("<@&role-1> is not currently active for <@user-1>."),
      );
    },
  );

  assert.deepEqual(storeCalls, [
    {
      input: "https://community-store/timed-roles?guildId=guild-123",
      method: "GET",
      body: null,
    },
  ]);
  assert.deepEqual(discordCalls, []);
});

test("worker returns the current timed role assignments for /timedrole list", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    createTimedRoleCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "list",
    }),
  );

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      guildEntitlementTier: "premium",
      moderationFetch(input, init) {
        storeCalls.push({
          input: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json([
          {
            guildId: "guild-123",
            userId: "user-1",
            roleId: "role-1",
            durationInput: "1w",
            expiresAtMs: 1_700_604_800_000,
          },
          {
            guildId: "guild-123",
            userId: "user-2",
            roleId: "role-2",
            durationInput: "2h",
            expiresAtMs: 1_700_007_200_000,
          },
        ]);
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage(
      "Active timed roles:\n- <@user-1> -> <@&role-1> (1w, expires <t:1700604800:R>)\n- <@user-2> -> <@&role-2> (2h, expires <t:1700007200:R>)",
    ),
  );
  assert.deepEqual(storeCalls, [
    {
      input: "https://community-store/timed-roles?guildId=guild-123",
      method: "GET",
      body: null,
    },
  ]);
});

test("worker returns the empty state for /timedrole list when no assignments are active", async () => {
  const storeCalls: Array<{ input: string; method: string; body: unknown }> = [];
  const { publicKeyHex, request } = await createSignedInteractionRequest(
    createTimedRoleCommand({
      guildId: "guild-123",
      permissions: "8",
      subcommand: "list",
    }),
  );

  const response = await worker.fetch(
    request,
    createEnv({
      DISCORD_PUBLIC_KEY: publicKeyHex,
      guildEntitlementTier: "premium",
      moderationFetch(input, init) {
        storeCalls.push({
          input: String(input),
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(String(init.body)) : null,
        });
        return Response.json([]);
      },
    }),
    {} as ExecutionContext,
  );

  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("No timed roles are active in this server."),
  );
  assert.deepEqual(storeCalls, [
    {
      input: "https://community-store/timed-roles?guildId=guild-123",
      method: "GET",
      body: null,
    },
  ]);
});

function createApplicationCommand(
  options:
    | { guildId: string; permissions: string; subcommand: "add" | "remove"; emoji: string }
    | { guildId: string; permissions: string; subcommand: "list" },
) {
  const subOptions =
    options.subcommand === "list" ? [] : [{ type: 3, name: "emoji", value: options.emoji }];

  return {
    type: 2,
    guild_id: options.guildId,
    member: {
      permissions: options.permissions,
      user: {
        id: "admin-1",
      },
    },
    data: {
      name: "blocklist",
      options: [
        {
          type: 1,
          name: options.subcommand,
          options: subOptions,
        },
      ],
    },
  };
}

function createHafAdminCommand(
  options:
    | {
        interactionGuildId: string;
        memberRoles: unknown;
        subcommand: "show-plan";
        guildId: string;
      }
    | {
        interactionGuildId: string;
        memberRoles: unknown;
        subcommand: "list-guilds";
      },
) {
  const subOptions =
    options.subcommand === "list-guilds"
      ? []
      : [{ type: 3, name: "guild_id", value: options.guildId }];

  return {
    type: 2,
    guild_id: options.interactionGuildId,
    member: {
      permissions: "0",
      roles: options.memberRoles,
      user: { id: "haf-admin-user" },
    },
    data: {
      name: "haf-admin",
      options: [{ type: 1, name: options.subcommand, options: subOptions }],
    },
  };
}

function createTimedRoleCommand(
  options:
    | {
        guildId: string;
        permissions: string;
        subcommand: "add";
        userId: string;
        roleId: string;
        duration: string;
      }
    | {
        guildId: string;
        permissions: string;
        subcommand: "remove";
        userId: string;
        roleId: string;
      }
    | { guildId: string; permissions: string; subcommand: "list" },
) {
  const subOptions =
    options.subcommand === "list"
      ? []
      : [
          { type: 6, name: "user", value: options.userId },
          { type: 8, name: "role", value: options.roleId },
          ...(options.subcommand === "add"
            ? [{ type: 3, name: "duration", value: options.duration }]
            : []),
        ];

  return {
    type: 2,
    guild_id: options.guildId,
    member: {
      permissions: options.permissions,
      user: {
        id: "admin-1",
      },
    },
    data: {
      name: "timedrole",
      options: [
        {
          type: 1,
          name: options.subcommand,
          options: subOptions,
        },
      ],
    },
  };
}

function createSteamManualLinkCommand(options: {
  guildId: string;
  permissions: string;
  userId: string;
  steamId64: string;
}) {
  return {
    type: 2,
    guild_id: options.guildId,
    member: {
      permissions: options.permissions,
      user: {
        id: "admin-1",
      },
    },
    data: {
      name: "steamlink",
      options: [
        {
          type: 1,
          name: "manual-link",
          options: [
            { type: 6, name: "user", value: options.userId },
            { type: 3, name: "steamid", value: options.steamId64 },
          ],
        },
      ],
    },
  };
}

function createMarketplacePost() {
  return {
    guildId: "guild-123",
    id: "post-1",
    ownerId: "owner-1",
    ownerDisplayName: "Owner",
    tradeType: "have",
    serverId: "namalsk",
    serverLabel: "Namalsk",
    have: "M4A1",
    want: "NVGs",
    extra: "Safe zone",
    channelId: "market-channel-1",
    messageId: "message-1",
    active: true,
    createdAtMs: 1,
    closedAtMs: null,
    closedByUserId: null,
  };
}

function createLfgPost() {
  return {
    guildId: "guild-123",
    id: "post-1",
    ownerId: "owner-1",
    ownerDisplayName: "Owner",
    serverId: "namalsk",
    serverLabel: "Namalsk",
    whenPlay: "Tonight",
    lookingFor: "Duo partner",
    extraInfo: "Bring meds",
    channelId: "lfg-channel-1",
    messageId: "message-1",
    active: true,
    createdAtMs: 1,
    expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
    reminderSentAtMs: null,
    renewedAtMs: null,
    renewalsCount: 0,
    closedAtMs: null,
    closedByUserId: null,
  };
}

function createLfgApplication() {
  return {
    guildId: "guild-123",
    postId: "post-1",
    applicantId: "applicant-1",
    applicantDisplayName: "Applicant",
    message: "I can run support.",
    status: "pending",
    createdAtMs: 1,
    updatedAtMs: 1,
    reviewedByUserId: null,
    reviewedAtMs: null,
  };
}

async function createSignedInteractionRequest(
  payload: unknown,
  options?: { timestamp?: string; signComponents?: boolean },
) {
  const { publicKeyHex, bodyText, timestamp, signatureHex } =
    await createSignedInteractionRequestBody(payload, options);

  return {
    publicKeyHex,
    request: new Request("https://worker.example/interactions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-signature-ed25519": signatureHex,
        "x-signature-timestamp": timestamp,
      },
      body: bodyText,
    }),
  };
}

async function createSignedInteractionRequestBody(
  payload: unknown,
  options?: { timestamp?: string; signComponents?: boolean },
) {
  const keyPair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const timestamp = options?.timestamp ?? String(Math.floor(Date.now() / 1000));
  if (
    options?.signComponents !== false &&
    isRecord(payload) &&
    (payload.type === 3 || payload.type === 5) &&
    isRecord(payload.data) &&
    typeof payload.data.custom_id === "string"
  ) {
    const member = isRecord(payload.member) ? payload.member : null;
    const actor =
      member && isRecord(member.user) ? member.user : isRecord(payload.user) ? payload.user : null;
    payload = {
      ...payload,
      data: {
        ...payload.data,
        custom_id: await signSensitiveComponentId(
          payload.data.custom_id,
          createComponentIdSigner({
            currentSecret: "component-id-signing-secret-for-production-tests",
          }),
          {
            guildId: typeof payload.guild_id === "string" ? payload.guild_id : undefined,
            actorUserId: typeof actor?.id === "string" ? actor.id : undefined,
            expiresAtMs: Date.now() + 60_000,
          },
        ),
      },
    };
  }
  const bodyText = JSON.stringify(payload);
  const signature = await crypto.subtle.sign(
    "Ed25519",
    keyPair.privateKey,
    new TextEncoder().encode(`${timestamp}${bodyText}`),
  );
  const publicKey = (await crypto.subtle.exportKey("raw", keyPair.publicKey)) as ArrayBuffer;

  return {
    publicKeyHex: toHex(new Uint8Array(publicKey)),
    bodyText,
    timestamp,
    signatureHex: toHex(new Uint8Array(signature)),
  };
}

function createEnv(options?: {
  DISCORD_PUBLIC_KEY?: string;
  HAF_ADMIN_GUILD_ID?: string;
  HAF_ADMIN_ROLE_ID?: string;
  guildEntitlementTier?: "free" | "premium";
  guildEntitlementTiers?: Record<string, "free" | "premium">;
  guildEntitlementWrites?: unknown[];
  moderationFetch?: (input: Request | string | URL, init?: RequestInit) => Response;
  appDb?: D1Database;
}) {
  return {
    DISCORD_BOT_TOKEN: "bot-token",
    BOT_USER_ID: "bot-user-id",
    DISCORD_PUBLIC_KEY: options?.DISCORD_PUBLIC_KEY ?? "",
    COMPONENT_ID_SIGNING_SECRET: "component-id-signing-secret-for-production-tests",
    HAF_ADMIN_GUILD_ID: options?.HAF_ADMIN_GUILD_ID,
    HAF_ADMIN_ROLE_ID: options?.HAF_ADMIN_ROLE_ID,
    GATEWAY_SESSION_DO: {
      idFromName() {
        return "gateway-session-id" as never;
      },
      get() {
        return {
          fetch: async () => Response.json({ status: "idle" }),
        };
      },
    } as never,
    GATEWAY_EVENT_QUEUE: { send: async () => undefined } as never,
    HAF_DB:
      options?.appDb ??
      (options?.moderationFetch ||
      options?.guildEntitlementTier ||
      options?.guildEntitlementTiers ||
      options?.guildEntitlementWrites
        ? createLegacyCommunityStoreDatabase({
            moderationFetch: options.moderationFetch,
            guildEntitlementTier: options.guildEntitlementTier,
            guildEntitlementTiers: options.guildEntitlementTiers,
            guildEntitlementWrites: options.guildEntitlementWrites,
          })
        : createLegacyCommunityStoreDatabase()),
  } as {
    DISCORD_BOT_TOKEN: string;
    BOT_USER_ID: string;
    DISCORD_PUBLIC_KEY: string;
    COMPONENT_ID_SIGNING_SECRET: string;
    HAF_ADMIN_GUILD_ID?: string;
    HAF_ADMIN_ROLE_ID?: string;
    GATEWAY_SESSION_DO: DurableObjectNamespace;
    GATEWAY_EVENT_QUEUE: Queue<unknown>;
    HAF_DB: D1Database;
  };
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function withMockedFetch<T>(
  handler: typeof globalThis.fetch,
  callback: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const channelsMatch = url.match(/\/guilds\/([^/]+)\/channels$/);
    if (channelsMatch) {
      const guildId = decodeURIComponent(channelsMatch[1]!);
      return Response.json(
        ["market-channel-1", "lfg-channel-1", "audit-channel-1", "log-channel-1"]
          .map((id) => ({
            id,
            guild_id: guildId,
            name: id,
            type: 0,
            parent_id: null,
            position: 0,
          }))
          .concat({
            id: "voice-category-1",
            guild_id: guildId,
            name: "voice-category-1",
            type: 4,
            parent_id: null,
            position: 0,
          }),
      );
    }
    if (/\/guilds\/[^/]+\/roles$/.test(url)) {
      return Response.json([{ id: "role-1", name: "role-1", permissions: "0", position: 0 }]);
    }
    return handler(input, init);
  };
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("createInteractionRoutes handles Discord PING interactions through route module", async () => {
  const { createInteractionRoutes } = await import("../src/routes/interaction-routes");
  const interactionRoutes = createInteractionRoutes({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    verifyDiscordRequest: async () => true,
    stores: createTestRuntimeStores(),
    gateway: {} as never,
    services: interactionServices(),
    handleInteractionRequest: async (request) => {
      const body = JSON.parse(await request.text());
      if (body?.type === 1) {
        return Response.json({ type: 1 });
      }
      return Response.json({ error: "Unsupported" }, { status: 400 });
    },
  });

  const { request } = await createSignedInteractionRequest({ type: 1 });
  const response = await interactionRoutes(request);

  assert(response !== null, "Route module should handle /interactions");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { type: 1 });
});

test("createInteractionRoutes handles exhausted Discord rate limits", async () => {
  const { createInteractionRoutes } = await import("../src/routes/interaction-routes");
  const interactionRoutes = createInteractionRoutes({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    stores: createTestRuntimeStores(),
    gateway: {} as never,
    services: interactionServices(),
    handleInteractionRequest: async () => {
      throw new DiscordApiError("rate limited", 429, "redacted", {
        retryAfterMs: 251,
        globalRateLimit: false,
      });
    },
  });

  const response = await interactionRoutes(
    new Request("https://runtime.example/interactions", { method: "POST" }),
  );

  assert(response !== null, "Route module should handle /interactions");
  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("Discord is temporarily rate limiting this action. Try again shortly."),
  );
});

test("createInteractionRoutes maps Marketplace rate limits after feature handling", async () => {
  const { createInteractionRoutes } = await import("../src/routes/interaction-routes");
  const { handleMarketplaceModalSubmitInteraction } =
    await import("../src/runtime/marketplace-interaction-handler");
  const stores = createTestRuntimeStores();
  const interactionRoutes = createInteractionRoutes({
    discordPublicKey: "a".repeat(64),
    discordBotToken: "bot-token",
    stores,
    gateway: {} as never,
    services: interactionServices(),
    handleInteractionRequest: async () =>
      handleMarketplaceModalSubmitInteraction(
        {
          type: 5,
          guild_id: "guild-1",
          channel_id: "channel-1",
          member: { user: { id: "user-1" } },
          data: { custom_id: "market:modal:have:~", components: [] },
        },
        {
          createPost: async () => {
            throw new DiscordApiError("rate limited", 429, "redacted", {
              retryAfterMs: 250,
              globalRateLimit: false,
            });
          },
        } as never,
      ),
  });

  const response = await interactionRoutes(
    new Request("https://runtime.example/interactions", { method: "POST" }),
  );

  assert(response !== null, "Route module should handle /interactions");
  assert.equal(response.status, 200);
  assert.deepEqual(
    await response.json(),
    buildEphemeralMessage("Discord is temporarily rate limiting this action. Try again shortly."),
  );
});
