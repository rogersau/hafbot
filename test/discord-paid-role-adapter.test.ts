/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";
import { DiscordPaidRoleAdapter } from "../src/runtime/commerce/discord-paid-role-adapter";
import { StripePaidRoleSubscriptionOperations } from "../src/runtime/commerce/stripe-paid-role-subscriptions";

test("paid-role Discord preflight enforces membership, Manage Roles, hierarchy, and managed roles", async () => {
  const originalFetch = globalThis.fetch;
  const manageRoles = String(1n << 28n);
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("/guilds/guild/roles")) {
      return Response.json([
        { id: "guild", name: "@everyone", permissions: "0", position: 0 },
        { id: "role-bot", name: "HAF", permissions: manageRoles, position: 10 },
        { id: "role-paid", name: "Paid", permissions: "0", position: 5 },
        { id: "role-managed", name: "Managed", permissions: "0", position: 4, managed: true },
      ]);
    }
    if (url.endsWith("/guilds/guild/members/bot")) {
      return Response.json({ user: { id: "bot" }, roles: ["role-bot"] });
    }
    if (url.endsWith("/guilds/guild/members/buyer")) {
      return Response.json({ user: { id: "buyer" }, roles: [] });
    }
    return new Response("not found", { status: 404 });
  };
  try {
    const adapter = new DiscordPaidRoleAdapter("bot", "token");
    assert.deepEqual(
      await adapter.preflightRole({
        guildId: "guild",
        discordRoleId: "role-paid",
        discordUserId: "buyer",
        action: "assign",
      }),
      { ok: true },
    );
    assert.deepEqual(
      await adapter.preflightRole({
        guildId: "guild",
        discordRoleId: "role-managed",
        discordUserId: "buyer",
        action: "assign",
      }),
      { ok: false, code: "role_missing" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("paid-role cancellation is always scoped to the connected seller", async () => {
  const calls: unknown[][] = [];
  const provider = new StripePaidRoleSubscriptionOperations({
    async requestForConnectedAccount(...args: unknown[]) {
      calls.push(args);
      return {};
    },
  });
  await provider.cancelAtPeriodEnd({
    connectedAccountId: "acct_seller",
    subscriptionId: "sub_buyer",
    idempotencyKey: "role-ban:cancel",
  });
  assert.equal(calls[0]?.[0], "acct_seller");
  assert.equal(calls[0]?.[1], "/v1/subscriptions/sub_buyer");
  const options = calls[0]?.[2] as {
    method: string;
    body: URLSearchParams;
    idempotencyKey: string;
  };
  assert.equal(options.method, "POST");
  assert.equal(options.body.get("cancel_at_period_end"), "true");
  assert.equal(options.idempotencyKey, "role-ban:cancel");
});
