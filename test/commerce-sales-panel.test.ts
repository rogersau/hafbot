/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import type { CommerceOfferingDashboard } from "../src/commerce/offering-service";
import {
  buildCommerceSalesPanelMessage,
  CommerceSalesPanelService,
  DEFAULT_COMMERCE_SALES_PANEL_DESCRIPTION,
  DEFAULT_COMMERCE_SALES_PANEL_TITLE,
  normalizeCommerceSalesPanelCopy,
  type CommerceSalesPanelServiceOptions,
} from "../src/commerce/sales-panel";
import type { CommerceSalesPanel } from "../src/commerce/types";
import { createDiscordCommerceSalesPanelAdapter } from "../src/runtime/commerce/discord-sales-panel";
import type { GuildResourceValidator } from "../src/discord/guild-resource-validator";

type OfferingRow = CommerceOfferingDashboard["offerings"][number];

function offeringRow(
  id: string,
  overrides: Partial<Pick<OfferingRow, "lifecycle" | "includedBenefits">> = {},
): OfferingRow {
  return {
    offering: {
      id,
      connectedAccountId: "account-1",
      guildId: "guild-1",
      discordRoleId: `role-${id}`,
      name: `Offering ${id}`,
      description: "Access to the private Discord area.",
      purchaseType: "subscription",
      status: "active",
      archivedAtMs: null,
      createdAtMs: 1,
      updatedAtMs: 1,
    },
    lifecycle: overrides.lifecycle ?? "published",
    subscribers: { active: 0, canceling: 0, pastDue: 0, grace: 0, disputed: 0 },
    grossByCurrency: { AUD: 0, USD: 0 },
    refundsByCurrency: { AUD: 0, USD: 0 },
    disputesByCurrency: { AUD: 0, USD: 0 },
    estimatedProceedsByCurrency: { AUD: 0, USD: 0 },
    activePrices: [
      {
        id: `price-${id}`,
        connectedAccountId: "account-1",
        offeringId: id,
        stripeProductId: `product-${id}`,
        stripePriceId: `stripe-price-${id}`,
        currency: "AUD",
        unitAmountMinor: 500,
        priceType: "recurring",
        recurringInterval: "month",
        status: "active",
        providerCreatedAtMs: 1,
        retiredAtMs: null,
        createdAtMs: 1,
      },
    ],
    includedBenefits: overrides.includedBenefits ?? ["Private role access"],
    supportContact: "seller@example.test",
    upcomingCancellations: 0,
    roleFailures: 0,
    reconciliationIncidents: 0,
    retirement: null,
  };
}

function renderInput(
  offerings: OfferingRow[],
  supportEnabled = false,
  copy?: { title: string; description: string },
) {
  return buildCommerceSalesPanelMessage({
    guildId: "guild-1",
    publicBaseUrl: "https://haf.test",
    offerings,
    supportEnabled,
    ...copy,
  });
}

test("sales panel renderer keeps storefront links, seller clarity, and component limits", () => {
  const message = renderInput([offeringRow("one"), offeringRow("two")], true);
  const embed = message.embeds?.[0] as {
    fields: Array<{ name: string; value: string }>;
    footer: { text: string };
  };
  const components = message.components as Array<{
    components: Array<{ label: string; url: string }>;
  }>;
  assert.equal(embed.fields.length, 2);
  assert.match(embed.footer.text, /Sold by this Discord server/);
  assert.equal(components[0]?.components.length, 3);
  assert.equal(components[0]?.components[0]?.url, "https://haf.test/commerce/offers/one");
  assert.equal(components[0]?.components[2]?.url, "https://haf.test/commerce/support/guild-1");
  assert.deepEqual(message.allowed_mentions, { parse: [] });
  assert.throws(
    () =>
      renderInput(
        Array.from({ length: 25 }, (_, index) => offeringRow(`offering-${index}`)),
        true,
      ),
    /commerce_sales_panel_button_limit/,
  );
});

test("sales panel renderer omits support when support capability is disabled", () => {
  const message = renderInput([offeringRow("one")], false);
  const components = message.components as Array<{
    components: Array<{ label: string; url: string }>;
  }>;
  assert.equal(components[0]?.components.length, 1);
  assert.equal(components[0]?.components[0]?.label, "Get Offering one");
  assert.doesNotMatch(JSON.stringify(message), /support\/guild-1/);
});

test("sales panel renderer uses seller-controlled copy within Discord limits", () => {
  const message = renderInput([offeringRow("one")], false, {
    title: "  Pick your community access  ",
    description: "  Get the perks that suit you.  ",
  });
  const embed = message.embeds?.[0] as { title: string; description: string };
  assert.equal(embed.title, "Pick your community access");
  assert.equal(embed.description, "Get the perks that suit you.");
  assert.throws(
    () => normalizeCommerceSalesPanelCopy({ title: " ", description: "Anything" }),
    /commerce_sales_panel_title_invalid/,
  );
  assert.throws(
    () => normalizeCommerceSalesPanelCopy({ title: "Valid", description: "x".repeat(4_097) }),
    /commerce_sales_panel_description_invalid/,
  );
});

test("sales panel renderer budgets copy and offering fields to Discord's aggregate embed limit", () => {
  const offerings = Array.from({ length: 2 }, (_, index) => {
    const row = offeringRow(`offering-${index}`);
    row.offering.description = "Detailed offering copy ".repeat(80);
    row.includedBenefits = ["Benefit ".repeat(80), "Another benefit ".repeat(80)];
    return row;
  });
  const message = renderInput(offerings, false, {
    title: "T".repeat(256),
    description: "D".repeat(4_096),
  });
  const embed = message.embeds?.[0] as {
    title: string;
    description?: string;
    fields: Array<{ name: string; value: string }>;
    footer: { text: string };
  };
  const size = [
    embed.title,
    embed.description,
    embed.footer.text,
    ...embed.fields.flatMap((field) => [field.name, field.value]),
  ]
    .filter((value): value is string => typeof value === "string")
    .reduce((total, value) => total + value.length, 0);
  assert.ok(size <= 6_000);
  assert.ok(embed.description);
  assert.ok((embed.description?.length ?? 0) < 4_096);
  assert.equal(embed.fields.length, offerings.length);
});

function createService(options: {
  rows?: OfferingRow[];
  saveFails?: () => boolean;
  discordFails?: () => boolean;
  publishBarrier?: Promise<void>;
  onPublishStart?: () => void;
}) {
  let saved: CommerceSalesPanel | null = null;
  let leaseToken: string | null = null;
  let pendingChannelId: string | null = null;
  let pendingTitle: string | null = null;
  let pendingDescription: string | null = null;
  let publicationNonce: string | null = null;
  let idSequence = 0;
  const publishCalls: Array<{
    channelId: string;
    messageId: string | null;
    offeringCount: number;
    createNonce: string;
    title: string;
    description: string;
  }> = [];
  const deleted: string[] = [];
  const account = {
    id: "account-1",
    guildId: "guild-1",
  };
  const rows = options.rows ?? [offeringRow("one")];
  const service = new CommerceSalesPanelService({
    store: {
      async readConnectedAccountByGuild() {
        return account as never;
      },
      async readSalesPanel() {
        return saved;
      },
      async claimSalesPanelPublication(input) {
        if (leaseToken) return null;
        const recovering = publicationNonce !== null;
        saved ??= {
          connectedAccountId: input.connectedAccountId,
          guildId: input.guildId,
          channelId: input.targetChannelId,
          title: DEFAULT_COMMERCE_SALES_PANEL_TITLE,
          description: DEFAULT_COMMERCE_SALES_PANEL_DESCRIPTION,
          messageId: null,
          lastErrorCode: null,
          createdAtMs: input.nowMs,
          updatedAtMs: input.nowMs,
        };
        leaseToken = input.leaseToken;
        pendingChannelId ??= input.targetChannelId;
        pendingTitle ??= input.title;
        pendingDescription ??= input.description;
        publicationNonce ??= input.createNonce;
        return {
          panel: saved,
          targetChannelId: pendingChannelId,
          title: pendingTitle,
          description: pendingDescription,
          createNonce: publicationNonce,
          recovering,
        };
      },
      async completeSalesPanelPublication(input) {
        if (leaseToken !== input.leaseToken || options.saveFails?.()) return false;
        saved = input.panel;
        leaseToken = null;
        pendingChannelId = null;
        pendingTitle = null;
        pendingDescription = null;
        publicationNonce = null;
        return true;
      },
      async failSalesPanelPublication(input) {
        if (leaseToken !== input.leaseToken) return false;
        saved = saved
          ? { ...saved, lastErrorCode: input.errorCode, updatedAtMs: input.nowMs }
          : null;
        leaseToken = null;
        if (!input.preservePending) {
          pendingChannelId = null;
          pendingTitle = null;
          pendingDescription = null;
          publicationNonce = null;
        }
        return true;
      },
      async deleteSalesPanelProjection(input) {
        if (leaseToken !== input.leaseToken) return false;
        saved = null;
        leaseToken = null;
        pendingChannelId = null;
        pendingTitle = null;
        pendingDescription = null;
        publicationNonce = null;
        return true;
      },
    },
    catalog: {
      async readDashboard() {
        return {
          seller: null,
          offerings: rows,
          estimatedProceedsAreNonAuthoritative: true,
        };
      },
      async readPublishContext() {
        return {
          premiumActive: true,
          sellerEligible: true,
          termsAccepted: true,
          roleManageable: true,
        };
      },
    },
    discord: {
      async publish(input) {
        options.onPublishStart?.();
        await options.publishBarrier;
        if (options.discordFails?.()) throw new Error("discord unavailable");
        const embed = input.message.embeds?.[0] as
          | { title?: string; description?: string; fields?: unknown[] }
          | undefined;
        publishCalls.push({
          channelId: input.channelId,
          messageId: input.messageId,
          offeringCount: embed?.fields?.length ?? 0,
          createNonce: input.createNonce,
          title: embed?.title ?? "",
          description: embed?.description ?? "",
        });
        return {
          messageId: input.messageId ?? `message-${input.channelId.replace("channel-", "")}`,
          created: input.messageId === null,
        };
      },
      async deleteMessage(_guildId, _channelId, messageId) {
        deleted.push(messageId);
      },
    },
    publicBaseUrl: "https://haf.test",
    now: () => 100,
    createLeaseToken: () => `lease-${++idSequence}`,
    createNonce: () => `nonce-${idSequence}`,
  } satisfies CommerceSalesPanelServiceOptions);
  return {
    service,
    getSaved: () => saved,
    publishCalls,
    deleted,
  };
}

test("sales panel service publishes, edits in place, filters unavailable offerings, and unpublishes idempotently", async () => {
  const setup = createService({
    rows: [offeringRow("published"), offeringRow("draft", { lifecycle: "draft" })],
  });
  const first = await setup.service.publish({
    connectedAccountId: "account-1",
    guildId: "guild-1",
    channelId: "channel-1",
    title: "Choose your access",
    description: "Member benefits, your way.",
  });
  assert.equal(first.messageId, "message-1");
  assert.equal(setup.publishCalls[0]?.messageId, null);
  assert.equal(setup.publishCalls[0]?.offeringCount, 1);
  assert.equal(setup.publishCalls[0]?.title, "Choose your access");
  assert.equal(setup.publishCalls[0]?.description, "Member benefits, your way.");

  const refreshed = await setup.service.publish({
    connectedAccountId: "account-1",
    guildId: "guild-1",
    channelId: "channel-1",
  });
  assert.equal(refreshed.messageId, "message-1");
  assert.equal(setup.publishCalls[1]?.messageId, "message-1");
  assert.equal(setup.deleted.length, 0);
  const moved = await setup.service.publish({
    connectedAccountId: "account-1",
    guildId: "guild-1",
    channelId: "channel-2",
  });
  assert.equal(moved.channelId, "channel-2");
  assert.equal(moved.messageId, "message-2");
  assert.equal(setup.publishCalls[2]?.messageId, null);
  assert.deepEqual(setup.deleted, ["message-1"]);

  const removed = await setup.service.unpublish({
    connectedAccountId: "account-1",
    guildId: "guild-1",
  });
  assert.equal(removed?.messageId, null);
  assert.deepEqual(setup.deleted, ["message-1", "message-2"]);
  assert.equal(
    (await setup.service.unpublish({ connectedAccountId: "account-1", guildId: "guild-1" }))
      ?.messageId,
    null,
  );
});

test("sales panel service excludes non-subscription and non-recurring offerings", async () => {
  const oneTime = offeringRow("one-time");
  oneTime.offering.purchaseType = "one_time";
  const nonRecurring = offeringRow("one-off-price");
  nonRecurring.activePrices[0] = {
    ...nonRecurring.activePrices[0]!,
    priceType: "one_time",
    recurringInterval: null,
  };
  const setup = createService({ rows: [oneTime, nonRecurring, offeringRow("subscription")] });
  await setup.service.publish({
    connectedAccountId: "account-1",
    guildId: "guild-1",
    channelId: "channel-1",
  });
  assert.equal(setup.publishCalls[0]?.offeringCount, 1);
});

test("sales panel service serializes concurrent publication and removes offboarding projection", async () => {
  let releasePublish!: () => void;
  let signalPublishStarted!: () => void;
  const publishBarrier = new Promise<void>((resolve) => {
    releasePublish = resolve;
  });
  const publishStarted = new Promise<void>((resolve) => {
    signalPublishStarted = resolve;
  });
  const setup = createService({
    publishBarrier,
    onPublishStart: signalPublishStarted,
  });
  const first = setup.service.publish({
    connectedAccountId: "account-1",
    guildId: "guild-1",
    channelId: "channel-1",
  });
  await publishStarted;
  await assert.rejects(
    () =>
      setup.service.publish({
        connectedAccountId: "account-1",
        guildId: "guild-1",
        channelId: "channel-1",
      }),
    /commerce_sales_panel_publication_in_progress/,
  );
  releasePublish();
  await first;
  assert.equal(setup.publishCalls.length, 1);

  await setup.service.removeForOffboarding({
    connectedAccountId: "account-1",
    guildId: "guild-1",
  });
  assert.equal(setup.getSaved(), null);
  assert.deepEqual(setup.deleted, ["message-1"]);
});

test("sales panel service records Discord refresh failure and compensates a failed D1 save", async () => {
  let failDiscord = false;
  const setup = createService({ discordFails: () => failDiscord });
  await setup.service.publish({
    connectedAccountId: "account-1",
    guildId: "guild-1",
    channelId: "channel-1",
  });
  failDiscord = true;
  await assert.rejects(
    () =>
      setup.service.publish({
        connectedAccountId: "account-1",
        guildId: "guild-1",
        channelId: "channel-1",
      }),
    /discord unavailable/,
  );
  assert.equal(setup.getSaved()?.lastErrorCode, "commerce_sales_panel_refresh_failed");

  const compensation = createService({ saveFails: () => true });
  await assert.rejects(
    () =>
      compensation.service.publish({
        connectedAccountId: "account-1",
        guildId: "guild-1",
        channelId: "channel-1",
      }),
    /commerce_sales_panel_persistence_failed/,
  );
  assert.deepEqual(compensation.deleted, ["message-1"]);
});

test("Discord sales panel adapter edits, recreates after 404, and deletes missing messages idempotently", async () => {
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  const bodies: unknown[] = [];
  const validator = {
    async requireTextChannel() {
      return { id: "channel-1", name: "sales", type: 0, parent_id: null, position: 0 };
    },
  } as unknown as GuildResourceValidator;
  try {
    globalThis.fetch = async (input, init) => {
      requests.push(`${init?.method ?? "GET"} ${String(input)}`);
      bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : null);
      if (requests.length === 1) return new Response("missing", { status: 404 });
      if (requests.length === 2)
        return Response.json({ id: "message-new", channel_id: "channel-1", content: "" });
      return new Response(null, { status: 404 });
    };
    const adapter = createDiscordCommerceSalesPanelAdapter({
      discordBotToken: "bot-token",
      guildResources: validator,
    });
    const recreated = await adapter.publish({
      guildId: "guild-1",
      channelId: "channel-1",
      messageId: "message-old",
      message: { content: "panel" },
      createNonce: "panel-nonce",
    });
    assert.deepEqual(recreated, { messageId: "message-new", created: true });
    await adapter.deleteMessage("guild-1", "channel-1", "message-new");
    assert.match(requests[0] ?? "", /^PATCH /);
    assert.match(requests[1] ?? "", /^POST /);
    assert.match(requests[2] ?? "", /^DELETE /);
    assert.equal((bodies[0] as Record<string, unknown>).nonce, undefined);
    assert.deepEqual(
      {
        nonce: (bodies[1] as Record<string, unknown>).nonce,
        enforceNonce: (bodies[1] as Record<string, unknown>).enforce_nonce,
      },
      { nonce: "panel-nonce", enforceNonce: true },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
