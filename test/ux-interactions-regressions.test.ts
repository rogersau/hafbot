import assert from "node:assert/strict";
import test from "node:test";
import { extractCommandInvocation } from "../src/discord-interactions";
import { handleApplicationCommand } from "../src/runtime/application-command-handler";
import { ALL_FEATURES_ENABLED } from "../src/runtime/features";
import {
  handleMessageComponentInteraction,
  handleTicketSlashCommandInteraction,
} from "../src/runtime/ticket-interaction-handler";
import { handleLfgModalSubmitInteraction } from "../src/runtime/lfg-interaction-handler";
import { createSuggestionsAdminRoutes } from "../src/runtime/admin-routes/suggestions";
import { defaultSuggestionsConfig } from "../src/suggestions";
import { LfgService } from "../src/services/lfg-service";
import { TimedRoleService } from "../src/services/timed-role-service";
import { buildTicketOpeningMessage } from "../src/services/tickets/ticket-lifecycle";
import { createStaticGuildResourceValidator, testRole } from "./helpers/guild-resource-validator";
import { buildTicketClaimCustomId } from "../src/tickets";
import type { TicketInstance, TicketPanelConfig } from "../src/types";
import type { DiscordInteraction } from "../src/runtime/app-types";
import { createProductionRuntimeStores } from "./support/production-runtime-stores";

for (const root of ["blocklist", "timedrole", "playercount"] as const) {
  test(`/${root} list dispatches its own registered root/subcommand`, () => {
    assert.deepEqual(
      extractCommandInvocation({ data: { name: root, options: [{ type: 1, name: "list" }] } }),
      {
        commandName: root,
        subcommandName: "list",
      },
    );
  });
}

test("Free Timed Roles lists assignments while Free Player Count gives the real plan restriction", async () => {
  const fixture = createProductionRuntimeStores();
  try {
    for (const [name, expected] of [
      ["timedrole", /No timed roles/],
      ["playercount", /paid plan/],
    ] as const) {
      const response = await handleApplicationCommand(
        {
          type: 2,
          guild_id: "guild-1",
          member: { permissions: "8", user: { id: "staff-1" } },
          data: { name, options: [{ type: 1, name: "list" }] },
        },
        fixture.stores,
        "fictional-token",
        ALL_FEATURES_ENABLED,
      );
      assert.match(
        ((await response.json()) as { data: { content: string } }).data.content,
        expected,
      );
    }
    const denied = await handleApplicationCommand(
      {
        type: 2,
        guild_id: "guild-1",
        member: { permissions: "0", user: { id: "member-1" } },
        data: { name: "timedrole", options: [{ type: 1, name: "list" }] },
      },
      fixture.stores,
      "fictional-token",
      ALL_FEATURES_ENABLED,
    );
    assert.match(((await denied.json()) as { data: { content: string } }).data.content, /admin/i);
  } finally {
    fixture.close();
  }
});

test("Free Timed Roles completes add/list/remove through the real service and rejects foreign roles", async () => {
  const fixture = createProductionRuntimeStores();
  const roleChanges: string[] = [];
  const service = new TimedRoleService(
    fixture.stores.timedRoles,
    "fictional-token",
    createStaticGuildResourceValidator({
      guilds: { "guild-1": { channels: [], roles: [testRole("role-1")] } },
    }),
    async () => {
      roleChanges.push("add");
    },
    async () => {
      roleChanges.push("remove");
    },
  );
  async function command(name: string, roleId = "role-1") {
    const response = await handleApplicationCommand(
      {
        type: 2,
        guild_id: "guild-1",
        member: { permissions: "8", user: { id: "staff-1" } },
        data: {
          name: "timedrole",
          options: [
            {
              type: 1,
              name,
              options: [
                { type: 6, name: "user", value: "member-1" },
                { type: 8, name: "role", value: roleId },
                { type: 3, name: "duration", value: "1h" },
              ],
            },
          ],
        },
      },
      fixture.stores,
      "fictional-token",
      ALL_FEATURES_ENABLED,
      { services: { timedRoleService: service } },
    );
    return ((await response.json()) as { data: { content: string } }).data.content;
  }
  try {
    assert.match(await command("add"), /Assigned/);
    assert.match(await command("list"), /member-1.*role-1/);
    assert.match(await command("remove"), /Removed/);
    assert.deepEqual(roleChanges, ["add", "remove"]);
    assert.equal((await fixture.stores.timedRoles.listTimedRoles()).length, 0);
    await command("add", "foreign-role");
    assert.deepEqual(roleChanges, ["add", "remove"]);
    assert.equal((await fixture.stores.timedRoles.listTimedRoles()).length, 0);
  } finally {
    fixture.close();
  }
});

for (const failure of ["opening", "announcement", "audit"] as const) {
  test(`ticket claim retry completes delivery after a failed ${failure} without repeating completed notifications`, async () => {
    const fixture = createProductionRuntimeStores();
    const originalFetch = globalThis.fetch;
    let failOnce = true;
    const deliveries: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const phase =
        init?.method === "PATCH" ? "opening" : url.includes("/audit-1/") ? "audit" : "announcement";
      if (phase === failure && failOnce) {
        failOnce = false;
        return Response.json(
          { message: "Fictional Discord failure", code: 50013 },
          { status: 403 },
        );
      }
      deliveries.push(phase);
      return Response.json({ id: "message-1", channel_id: "ticket-1", content: "" });
    };
    try {
      await seedClaimTicket(fixture.stores);
      const claim = () =>
        handleMessageComponentInteraction(
          claimInteraction("staff-1"),
          fixture.stores,
          "fictional-token",
          "https://example.test",
        );
      const first = await claim();
      assert.match(
        ((await first.json()) as { data: { content: string } }).data.content,
        /claimed.*but/i,
      );
      const committed = await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "ticket-1");
      await claim();
      assert.equal(deliveries.filter((phase) => phase === "announcement").length, 1);
      assert.equal(deliveries.filter((phase) => phase === "audit").length, 1);
      await claim();
      assert.equal(deliveries.filter((phase) => phase === "announcement").length, 1);
      assert.equal(deliveries.filter((phase) => phase === "audit").length, 1);
      assert.equal(
        (await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "ticket-1"))?.claimedAtMs,
        committed?.claimedAtMs,
      );
    } finally {
      globalThis.fetch = originalFetch;
      fixture.close();
    }
  });
}

test("concurrent retries of a committed ticket claim deliver each notification once", async () => {
  const fixture = createProductionRuntimeStores();
  const originalFetch = globalThis.fetch;
  const deliveries: string[] = [];
  let release!: () => void;
  let started!: () => void;
  const blocked = new Promise<void>((done) => {
    release = done;
  });
  const sending = new Promise<void>((done) => {
    started = done;
  });
  globalThis.fetch = async (input, init) => {
    const phase =
      init?.method === "PATCH"
        ? "opening"
        : String(input).includes("/audit-1/")
          ? "audit"
          : "announcement";
    deliveries.push(phase);
    if (phase === "announcement") {
      started();
      await blocked;
    }
    return Response.json({ id: "message-1", channel_id: "ticket-1", content: "" });
  };
  try {
    await seedClaimTicket(fixture.stores);
    const claim = () =>
      handleMessageComponentInteraction(
        claimInteraction("staff-1"),
        fixture.stores,
        "fictional-token",
        "https://example.test",
      );
    const first = claim();
    await sending;
    await claim();
    release();
    await first;
    assert.equal(deliveries.filter((phase) => phase === "announcement").length, 1);
    assert.equal(deliveries.filter((phase) => phase === "audit").length, 1);
  } finally {
    release?.();
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

test("a ticket claim retries an ambiguous delivery with the same Discord nonce", async () => {
  const fixture = createProductionRuntimeStores();
  const originalFetch = globalThis.fetch;
  const sent = new Set<string>();
  const attempted: string[] = [];
  globalThis.fetch = async (_input, init) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      assert.equal(body.enforce_nonce, true);
      assert.equal(body.nonce.length, 25);
      attempted.push(body.nonce);
      sent.add(body.nonce);
    }
    return Response.json({ id: "message-1", channel_id: "ticket-1", content: "" });
  };
  try {
    await seedClaimTicket(fixture.stores);
    const complete = fixture.stores.tickets.completeTicketClaimDelivery.bind(
      fixture.stores.tickets,
    );
    let failOnce = true;
    fixture.stores.tickets.completeTicketClaimDelivery = async (delivery) => {
      if (failOnce) {
        failOnce = false;
        throw new Error("Fictional persistence failure after delivery");
      }
      await complete(delivery);
    };
    const claim = () =>
      handleMessageComponentInteraction(
        claimInteraction("staff-1"),
        fixture.stores,
        "fictional-token",
        "https://example.test",
      );
    await claim();
    await claim();
    await claim();
    assert.equal(attempted.length, 3);
    assert.equal(attempted[0], attempted[1]);
    assert.equal(sent.size, 2);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

for (const delay of ["GET", "PATCH", "ambiguous PATCH"] as const) {
  test(`concurrent ticket transfers reconcile the owner after a delayed opening ${delay}`, async () => {
    const fixture = createProductionRuntimeStores();
    const originalFetch = globalThis.fetch;
    let opening = claimInteraction("staff-1").message!;
    let release!: () => void;
    let started!: () => void;
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const sending = new Promise<void>((done) => {
      started = done;
    });
    let delayOnce = true;
    let first: Promise<Response> | undefined;
    globalThis.fetch = async (input, init) => {
      const method = init?.method ?? "GET";
      const delayed = method === (delay === "GET" ? "GET" : "PATCH") && delayOnce;
      if (delayed) {
        delayOnce = false;
        started();
        await blocked;
      }
      if (method === "GET") {
        assert.match(String(input), /\/channels\/ticket-1\/messages\/opening-1$/);
        return Response.json({ ...opening, channel_id: "ticket-1", content: "" });
      }
      if (method === "PATCH") {
        opening = { ...opening, ...JSON.parse(String(init?.body)) };
        if (delayed && delay === "ambiguous PATCH") {
          throw new Error("Fictional lost response after Discord applied the stale PATCH");
        }
      }
      return Response.json({ id: "message-1", channel_id: "ticket-1", content: "" });
    };
    try {
      await seedClaimTicket(fixture.stores);
      await fixture.stores.tickets.updateTicketOpeningMessageId({
        guildId: "guild-1",
        channelId: "ticket-1",
        openingMessageId: "opening-1",
      });
      first = handleTicketSlashCommandInteraction(
        {
          ...claimInteraction("staff-1"),
          type: 2,
          message: undefined,
          data: { name: "ticket", options: [{ type: 1, name: "claim" }] },
        },
        fixture.stores,
        "fictional-token",
        "https://example.test",
        "claim",
      );
      await Promise.race([
        sending,
        first.then(() => assert.fail("The first claim completed before the controlled request")),
      ]);
      const second = await handleMessageComponentInteraction(
        claimInteraction("staff-2"),
        fixture.stores,
        "fictional-token",
        "https://example.test",
      );
      assert.match(
        ((await second.json()) as { data: { content: string } }).data.content,
        /Claimed this ticket/,
      );
      assert.deepEqual(opening.embeds?.[0].fields, [{ name: "Claimed by", value: "<@staff-2>" }]);
      release();
      assert.match(
        ((await (await first).json()) as { data: { content: string } }).data.content,
        /Claimed this ticket/,
      );
      assert.equal(
        (await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "ticket-1"))
          ?.claimedByUserId,
        "staff-2",
      );
      assert.deepEqual(opening.embeds?.[0].fields, [{ name: "Claimed by", value: "<@staff-2>" }]);
      assert.match(JSON.stringify(opening.components), /Transfer Claim/);
      assert.match(JSON.stringify(opening.components), /signed-claim-id/);
    } finally {
      release();
      await first;
      globalThis.fetch = originalFetch;
      fixture.close();
    }
  });
}

for (const priorButtonClaim of [true, false]) {
  test(`slash claim refreshes the opening message after ${priorButtonClaim ? "a button claim" : "legacy ticket creation"}`, async () => {
    const fixture = createProductionRuntimeStores();
    const originalFetch = globalThis.fetch;
    let opening = claimInteraction("staff-1").message!;
    const notifications: Record<string, unknown>[] = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (!init?.method || init.method === "GET") {
        if (!priorButtonClaim) {
          const request = new URL(url);
          assert.equal(request.pathname, "/api/v10/channels/ticket-1/messages");
          assert.equal(request.searchParams.get("after"), "ticket-1");
          return Response.json([
            { ...opening, author: { id: "bot-user-id" }, channel_id: "ticket-1", content: "" },
          ]);
        }
        assert.match(url, /\/channels\/ticket-1\/messages\/opening-1$/);
        return Response.json({ ...opening, channel_id: "ticket-1", content: "" });
      }
      const body = JSON.parse(String(init.body));
      if (init.method === "PATCH") {
        assert.match(url, /\/channels\/ticket-1\/messages\/opening-1$/);
        opening = { ...opening, ...body };
      } else if (url.includes("/ticket-1/")) {
        notifications.push(body);
      }
      return Response.json({ id: "message-1", channel_id: "ticket-1", content: "" });
    };
    try {
      await seedClaimTicket(fixture.stores);
      if (priorButtonClaim)
        await handleMessageComponentInteraction(
          claimInteraction("staff-1"),
          fixture.stores,
          "fictional-token",
          "https://example.test",
        );
      const response = await handleTicketSlashCommandInteraction(
        {
          ...claimInteraction("staff-2"),
          type: 2,
          message: undefined,
          data: { name: "ticket", options: [{ type: 1, name: "claim" }] },
        },
        fixture.stores,
        "fictional-token",
        "https://example.test",
        "claim",
      );
      assert.match(
        ((await response.json()) as { data: { content: string } }).data.content,
        /Claimed this ticket/,
      );
      assert.equal(
        (await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "ticket-1"))
          ?.claimedByUserId,
        "staff-2",
      );
      assert.deepEqual(opening.embeds?.[0].fields, [{ name: "Claimed by", value: "<@staff-2>" }]);
      assert.match(JSON.stringify(opening.components), /Transfer Claim/);
      assert.match(JSON.stringify(opening.components), /signed-claim-id/);
      assert.equal(notifications.length, priorButtonClaim ? 2 : 1);
      assert.equal(
        (await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "ticket-1"))
          ?.openingMessageId,
        "opening-1",
      );
    } finally {
      globalThis.fetch = originalFetch;
      fixture.close();
    }
  });
}

for (const claimAlreadySaved of [false, true]) {
  test(`slash claim delivers updates for a legacy opening without a Claim button${claimAlreadySaved ? " after ownership was already saved" : ""}`, async () => {
    const fixture = createProductionRuntimeStores();
    const originalFetch = globalThis.fetch;
    try {
      await seedClaimTicket(fixture.stores);
      const ticket = await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "ticket-1");
      assert.ok(ticket);
      assert.equal(ticket.openingMessageId, null);
      let opening = {
        id: "opening-1",
        author: { id: "bot-user-id" },
        channel_id: "ticket-1",
        ...buildTicketOpeningMessage(ticket, 1, { enableTicketClaiming: false }),
      };
      const originalComponents = opening.components;
      const deliveries: string[] = [];
      let openingSearches = 0;
      if (claimAlreadySaved) {
        await fixture.stores.tickets.updateTicketClaim({
          guildId: "guild-1",
          channelId: "ticket-1",
          claimedByUserId: "staff-1",
          claimedAtMs: 42,
        });
      }
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (!init?.method || init.method === "GET") {
          if (url.pathname.endsWith("/messages/opening-1")) return Response.json(opening);
          assert.equal(url.pathname, "/api/v10/channels/ticket-1/messages");
          assert.equal(url.searchParams.get("after"), "ticket-1");
          openingSearches++;
          return Response.json([
            { ...opening, id: "member-message", author: { id: "member-1" } },
            { ...opening, id: "other-bot-message", components: [] },
            opening,
          ]);
        }
        if (init.method === "PATCH") {
          assert.equal(url.pathname, "/api/v10/channels/ticket-1/messages/opening-1");
          opening = { ...opening, ...JSON.parse(String(init.body)) };
        } else {
          assert.equal(init.method, "POST");
          assert.match(url.pathname, /^\/api\/v10\/channels\/(ticket-1|audit-1)\/messages$/);
          deliveries.push(url.pathname.includes("/audit-1/") ? "audit" : "announcement");
        }
        return Response.json({ id: "message-1", channel_id: "ticket-1", content: "" });
      };
      const claim = () =>
        handleTicketSlashCommandInteraction(
          {
            ...claimInteraction("staff-1"),
            type: 2,
            message: undefined,
            data: { name: "ticket", options: [{ type: 1, name: "claim" }] },
          },
          fixture.stores,
          "fictional-token",
          "https://example.test",
          "claim",
        );
      const response = await claim();
      assert.match(
        ((await response.json()) as { data: { content: string } }).data.content,
        claimAlreadySaved ? /already claimed/ : /Claimed this ticket/,
      );
      const claimed = await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "ticket-1");
      assert.equal(claimed?.claimedByUserId, "staff-1");
      assert.equal(claimed?.openingMessageId, "opening-1");
      if (claimAlreadySaved) assert.equal(claimed?.claimedAtMs, 42);
      assert.deepEqual(opening.components, originalComponents);
      assert.deepEqual(opening.embeds[0].fields, [
        { name: "User", value: "<@opener-1>" },
        { name: "Claimed by", value: "<@staff-1>" },
      ]);
      const repeated = await claim();
      assert.match(
        ((await repeated.json()) as { data: { content: string } }).data.content,
        /already claimed/,
      );
      assert.deepEqual(deliveries, ["announcement", "audit"]);
      assert.equal(openingSearches, 1);
      assert.equal(
        (await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "ticket-1"))?.claimedAtMs,
        claimed?.claimedAtMs,
      );
    } finally {
      globalThis.fetch = originalFetch;
      fixture.close();
    }
  });
}

for (const storedOpening of [true, false]) {
  for (const failedNotification of [null, "announcement", "audit"] as const) {
    test(`slash claim recovers a missing ${storedOpening ? "stored" : "legacy"} opening with ${failedNotification ?? "no"} delivery failure`, async () => {
      const fixture = createProductionRuntimeStores();
      const originalFetch = globalThis.fetch;
      const deliveries: Array<{ phase: string; body: Record<string, unknown> }> = [];
      let failOnce = failedNotification !== null;
      let reads = 0;
      globalThis.fetch = async (input, init) => {
        const url = new URL(String(input));
        if (init?.method === "GET") {
          reads++;
          assert.equal(
            url.pathname,
            `/api/v10/channels/ticket-1/messages${storedOpening ? "/opening-1" : ""}`,
          );
          return storedOpening
            ? Response.json({ message: "Unknown Message", code: 10008 }, { status: 404 })
            : Response.json([]);
        }
        assert.equal(init?.method, "POST", "a missing opening must not be edited or recreated");
        const phase = url.pathname.includes("/audit-1/") ? "audit" : "announcement";
        if (phase === failedNotification && failOnce) {
          failOnce = false;
          return Response.json({ message: "Temporary failure" }, { status: 503 });
        }
        deliveries.push({ phase, body: JSON.parse(String(init?.body)) });
        return Response.json({ id: "message-1", channel_id: "ticket-1", content: "" });
      };
      const claim = async (userId = "staff-1", roles = ["support-role"]) => {
        const response = await handleTicketSlashCommandInteraction(
          {
            ...claimInteraction(userId),
            type: 2,
            message: undefined,
            member: { user: { id: userId }, roles },
            data: { name: "ticket", options: [{ type: 1, name: "claim" }] },
          },
          fixture.stores,
          "fictional-token",
          "https://example.test",
          "claim",
        );
        return ((await response.json()) as { data: { content: string } }).data.content;
      };
      try {
        await seedClaimTicket(fixture.stores);
        if (storedOpening)
          await fixture.stores.tickets.updateTicketOpeningMessageId({
            guildId: "guild-1",
            channelId: "ticket-1",
            openingMessageId: "opening-1",
          });
        assert.match(await claim("outsider", []), /support role/);
        assert.equal(reads, 0);
        assert.equal(
          (await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "ticket-1"))
            ?.claimedByUserId,
          null,
        );
        assert.match(await claim(), failedNotification ? /claimed.*but/i : /Claimed this ticket/);
        const committed = await fixture.stores.tickets.readOpenTicketByChannel(
          "guild-1",
          "ticket-1",
        );
        assert.equal(committed?.claimedByUserId, "staff-1");
        const readsBeforeDeniedRetry = reads;
        assert.match(await claim("staff-1", []), /support role/);
        assert.equal(reads, readsBeforeDeniedRetry);
        assert.match(await claim(), /already claimed/);
        assert.match(await claim(), /already claimed/);
        assert.deepEqual(
          deliveries.map(({ phase }) => phase),
          ["announcement", "audit"],
        );
        assert.equal(deliveries[0].body.content, "Ticket claimed by <@staff-1>.");
        assert.equal(
          (await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "ticket-1"))
            ?.claimedAtMs,
          committed?.claimedAtMs,
        );
        assert.match(await claim("staff-2"), /Claimed this ticket/);
        assert.match(await claim("staff-2"), /already claimed/);
        assert.deepEqual(
          deliveries.map(({ phase }) => phase),
          ["announcement", "audit", "announcement", "audit"],
        );
        assert.equal(deliveries[2].body.content, "Ticket claimed by <@staff-2>.");
        assert.equal(
          (await fixture.stores.tickets.readOpenTicketByChannel("guild-1", "ticket-1"))
            ?.claimedByUserId,
          "staff-2",
        );
      } finally {
        globalThis.fetch = originalFetch;
        fixture.close();
      }
    });
  }
}

for (const status of [403, 503]) {
  test(`slash claim retries opening lookup HTTP ${status} instead of treating it as a missing message`, async () => {
    const fixture = createProductionRuntimeStores();
    const originalFetch = globalThis.fetch;
    let unavailable = true;
    const deliveries: string[] = [];
    let opening = claimInteraction("staff-1").message!;
    globalThis.fetch = async (input, init) => {
      if (init?.method === "GET") {
        if (unavailable) return Response.json({ message: "Lookup failed" }, { status });
        return Response.json(opening);
      }
      if (init?.method === "PATCH") opening = { ...opening, ...JSON.parse(String(init.body)) };
      else deliveries.push(String(input).includes("/audit-1/") ? "audit" : "announcement");
      return Response.json({ id: "message-1", channel_id: "ticket-1", content: "" });
    };
    try {
      await seedClaimTicket(fixture.stores);
      await fixture.stores.tickets.updateTicketOpeningMessageId({
        guildId: "guild-1",
        channelId: "ticket-1",
        openingMessageId: "opening-1",
      });
      const claim = async () => {
        const response = await handleTicketSlashCommandInteraction(
          {
            ...claimInteraction("staff-1"),
            type: 2,
            message: undefined,
            data: { name: "ticket", options: [{ type: 1, name: "claim" }] },
          },
          fixture.stores,
          "fictional-token",
          "https://example.test",
          "claim",
        );
        return ((await response.json()) as { data: { content: string } }).data.content;
      };
      assert.match(await claim(), /claimed.*but/i);
      assert.deepEqual(deliveries, []);
      unavailable = false;
      assert.match(await claim(), /already claimed/);
      await claim();
      assert.deepEqual(deliveries, ["announcement", "audit"]);
      assert.deepEqual(opening.embeds?.[0].fields, [{ name: "Claimed by", value: "<@staff-1>" }]);
      assert.match(JSON.stringify(opening.components), /Transfer Claim/);
      assert.match(JSON.stringify(opening.components), /signed-claim-id/);
    } finally {
      globalThis.fetch = originalFetch;
      fixture.close();
    }
  });
}

function claimInteraction(userId: string): DiscordInteraction {
  return {
    type: 3,
    guild_id: "guild-1",
    channel_id: "ticket-1",
    member: { user: { id: userId }, roles: ["support-role"] },
    data: { custom_id: buildTicketClaimCustomId("ticket-1") },
    message: {
      id: "opening-1",
      embeds: [{ title: "Support Ticket #001", fields: [] }],
      components: [
        {
          type: 1,
          components: [{ type: 2, custom_id: "signed-claim-id", label: "Claim Ticket", style: 2 }],
        },
      ],
    },
  };
}

async function seedClaimTicket(stores: ReturnType<typeof createProductionRuntimeStores>["stores"]) {
  await stores.tickets.createTicketInstance({
    guildId: "guild-1",
    channelId: "ticket-1",
    ticketTypeId: "support",
    ticketTypeLabel: "Support",
    openerUserId: "opener-1",
    supportRoleId: "support-role",
    status: "open",
    answers: [],
    openedAtMs: 1,
    closedAtMs: null,
    closedByUserId: null,
    transcriptMessageId: null,
    staffThreadId: null,
  });
  await stores.tickets.upsertTicketPanelConfig({
    guildId: "guild-1",
    panelChannelId: "panel-1",
    categoryChannelId: "category-1",
    transcriptChannelId: "transcript-1",
    panelEmoji: null,
    panelTitle: null,
    panelDescription: null,
    panelFooter: null,
    panelMessageId: null,
    ticketCreationLimit: null,
    ticketLimitRejectionMessage: null,
    enableTicketClaiming: true,
    ticketTypes: [],
  });
  await stores.guildAuditLog.upsertConfig({
    guildId: "guild-1",
    auditChannelId: "audit-1",
    groupChannelIds: {},
    eventStates: { groups: {}, overrides: { "ticket.claim": true } },
    updatedAtMs: 1,
  });
}

test("paid Player Count list reaches its handler instead of Unsupported command", async () => {
  const fixture = createProductionRuntimeStores();
  fixture.stores.guildEntitlements.readGuildEntitlement = async (guildId) => ({
    guildId,
    tier: "premium",
    updatedAtMs: 1,
  });
  try {
    const response = await handleApplicationCommand(
      {
        type: 2,
        guild_id: "guild-1",
        member: { permissions: "8", user: { id: "staff-1" } },
        data: { name: "playercount", options: [{ type: 1, name: "list" }] },
      },
      fixture.stores,
      "fictional-token",
      ALL_FEATURES_ENABLED,
    );
    assert.match(
      ((await response.json()) as { data: { content: string } }).data.content,
      /No servers are configured/,
    );
  } finally {
    fixture.close();
  }
});

test("ticket claims defer slow work, preserve support authorization, and make repeats and transfers clear", async () => {
  const fixture = createProductionRuntimeStores();
  const originalFetch = globalThis.fetch;
  const messages: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
  globalThis.fetch = async (input, init) => {
    messages.push({
      url: String(input),
      method: init?.method ?? "GET",
      body: JSON.parse(String(init?.body)),
    });
    return Response.json({ id: "message-1", channel_id: "ticket-1", content: "" });
  };
  try {
    const ticket: TicketInstance = {
      guildId: "guild-1",
      channelId: "ticket-1",
      ticketTypeId: "support",
      ticketTypeLabel: "Support",
      openerUserId: "opener-1",
      supportRoleId: "support-role",
      status: "open",
      answers: [],
      openedAtMs: 1,
      closedAtMs: null,
      closedByUserId: null,
      transcriptMessageId: null,
      staffThreadId: null,
    };
    const panel: TicketPanelConfig = {
      guildId: "guild-1",
      panelChannelId: "panel-1",
      categoryChannelId: "category-1",
      transcriptChannelId: "transcript-1",
      panelEmoji: null,
      panelTitle: null,
      panelDescription: null,
      panelFooter: null,
      panelMessageId: null,
      ticketCreationLimit: null,
      ticketLimitRejectionMessage: null,
      enableTicketClaiming: true,
      ticketTypes: [],
    };
    await fixture.stores.tickets.createTicketInstance(ticket);
    await fixture.stores.tickets.upsertTicketPanelConfig(panel);
    function interaction(userId: string, roles = ["support-role"]): DiscordInteraction {
      return {
        type: 3,
        guild_id: "guild-1",
        channel_id: "ticket-1",
        application_id: "fictional-app",
        token: "fictional-interaction",
        member: { user: { id: userId }, roles },
        data: { custom_id: buildTicketClaimCustomId("ticket-1") },
        message: {
          id: "opening-1",
          embeds: [{ title: "Support Ticket #001", fields: [] }],
          components: [
            {
              type: 1,
              components: [
                { type: 2, custom_id: "signed-claim-id", label: "Claim Ticket", style: 2 },
              ],
            },
          ],
        },
      };
    }
    let release!: () => void;
    const blocked = new Promise<void>((done) => {
      release = done;
    });
    const read = fixture.stores.tickets.readOpenTicketByChannel.bind(fixture.stores.tickets);
    fixture.stores.tickets.readOpenTicketByChannel = async (...args) => {
      await blocked;
      return read(...args);
    };
    const tasks: Promise<unknown>[] = [];
    const response = await handleMessageComponentInteraction(
      interaction("staff-1"),
      fixture.stores,
      "fictional-token",
      "https://example.test",
      undefined,
      (task) => tasks.push(task),
    );
    assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
    assert.equal(messages.length, 0);
    release();
    await Promise.all(tasks);
    fixture.stores.tickets.readOpenTicketByChannel = read;
    const first = await read("guild-1", "ticket-1");
    const repeated = await handleMessageComponentInteraction(
      interaction("staff-1"),
      fixture.stores,
      "fictional-token",
      "https://example.test",
    );
    assert.match(
      ((await repeated.json()) as { data: { content: string } }).data.content,
      /already claimed/,
    );
    assert.equal((await read("guild-1", "ticket-1"))?.claimedAtMs, first?.claimedAtMs);
    assert.equal(messages.filter((item) => item.method === "POST").length, 1);
    await handleMessageComponentInteraction(
      interaction("staff-2"),
      fixture.stores,
      "fictional-token",
      "https://example.test",
    );
    assert.equal((await read("guild-1", "ticket-1"))?.claimedByUserId, "staff-2");
    assert.equal(messages.filter((item) => item.method === "POST").length, 2);
    const controls = messages.filter((item) => item.url.endsWith("/opening-1"));
    assert.match(JSON.stringify(controls.at(-1)?.body), /Transfer Claim/);
    assert.match(JSON.stringify(controls.at(-1)?.body), /staff-2/);
    assert.match(JSON.stringify(controls.at(-1)?.body), /signed-claim-id/);
    const denied = await handleMessageComponentInteraction(
      interaction("opener-1", []),
      fixture.stores,
      "fictional-token",
      "https://example.test",
    );
    assert.match(
      ((await denied.json()) as { data: { content: string } }).data.content,
      /support role/,
    );
    assert.equal(messages.filter((item) => item.method === "POST").length, 2);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

test("slow LFG submission acknowledges immediately and duplicate retry links to the persisted result", async () => {
  const fixture = createProductionRuntimeStores();
  const originalFetch = globalThis.fetch;
  const completions: string[] = [];
  globalThis.fetch = async (_input, init) => {
    completions.push(String(init?.body));
    return Response.json({ id: "completion" });
  };
  try {
    let release!: () => void;
    const slow = new Promise<void>((done) => {
      release = done;
    });
    let published = 0;
    const service = new LfgService(fixture.stores.lfg, {
      async createChannelMessage(channelId) {
        await slow;
        published++;
        return { id: `post-message-${published}`, channel_id: channelId, content: "" };
      },
      async editChannelMessage(channelId, messageId) {
        return { id: messageId, channel_id: channelId, content: "" };
      },
      async deleteChannelMessage() {},
      async createUserDmMessage() {
        return { id: "dm-1", channel_id: "dm-channel-1", content: "" };
      },
      async addGuildMemberRole() {},
      async removeGuildMemberRole() {},
      async modifyChannel() {},
    });
    await fixture.stores.lfg.upsertLfgConfig({
      ...(await service.getConfig("guild-1")),
      noticeChannelId: "lfg-1",
      serverOptions: [{ id: "namalsk", label: "Namalsk", emoji: null }],
    });
    const interaction: DiscordInteraction = {
      type: 5,
      guild_id: "guild-1",
      channel_id: "lfg-1",
      application_id: "fictional-app",
      token: "fictional-interaction",
      member: { user: { id: "poster-1", username: "Fictional poster" } },
      data: {
        custom_id: "lfg:modal:namalsk",
        components: [
          {
            type: 1,
            components: [
              { type: 4, custom_id: "when_play", value: "Tonight" },
              { type: 4, custom_id: "looking_for", value: "Two fictional players" },
            ],
          },
        ],
      },
    };
    const tasks: Promise<unknown>[] = [];
    const response = await handleLfgModalSubmitInteraction(
      interaction,
      fixture.stores,
      "fictional-token",
      { lfgService: service },
      (task) => tasks.push(task),
    );
    assert.deepEqual(await response.json(), { type: 5, data: { flags: 64 } });
    assert.equal(published, 0);
    release();
    await Promise.all(tasks);
    assert.match(completions[0] ?? "", /LFG post created/);
    assert.match(completions[0] ?? "", /View post/);
    const retry = await handleLfgModalSubmitInteraction(
      interaction,
      fixture.stores,
      "fictional-token",
      { lfgService: service },
    );
    assert.match(((await retry.json()) as { data: { content: string } }).data.content, /View post/);
    assert.equal(published, 2, "one post plus one noticeboard; retry creates neither");
    assert.equal((await fixture.stores.lfg.listLfgPosts("guild-1", { limit: 50 })).length, 1);
  } finally {
    globalThis.fetch = originalFetch;
    fixture.close();
  }
});

test("shipped Suggestions defaults satisfy the first-save API and still reject invalid prompt labels", () => {
  const fixture = createProductionRuntimeStores();
  try {
    const route = createSuggestionsAdminRoutes({
      stores: fixture.stores,
      token: "fictional-token",
    }).find((item) => item.method === "PUT")!;
    const config = defaultSuggestionsConfig("guild-1");
    assert.equal(route.body?.safeParse(config).success, true);
    assert.equal(
      route.body?.safeParse({
        ...config,
        prompts: [{ id: "test", label: "x".repeat(46), required: true }],
      }).success,
      false,
    );
    assert.equal(route.body?.safeParse({ ...config, workspaceId: "" }).success, false);
  } finally {
    fixture.close();
  }
});
