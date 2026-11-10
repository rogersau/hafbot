/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- Runtime tests compile under tsconfig.tests.json.
import test from "node:test";

import type { CommerceOffering, CommerceSalesPanel } from "../src/commerce/types";
import {
  createCommerceAdminRoutes,
  type CommerceAdminServices,
} from "../src/runtime/admin-routes/commerce";

test("Commerce Admin returns an onboarding state without inventing a wallet", async () => {
  const routes = createCommerceAdminRoutes({
    services: services(null),
    discordBotToken: "token",
    readCustomerAdminSession: sellerSession,
    isGuildOwner: async () => true,
  });
  const route = routes.find(
    (candidate) => candidate.method === "GET" && candidate.path === "/admin/api/commerce",
  );
  assert.ok(route);
  const response = await route.handler({
    request: new Request("https://example.test/admin/api/commerce?guildId=guild-1"),
    url: new URL("https://example.test/admin/api/commerce?guildId=guild-1"),
    params: {},
    query: { guildId: "guild-1" },
    body: undefined,
  });
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.dashboard, null);
  assert.equal(body.stripeDashboardAvailable, false);
  assert.equal(body.activeOfferingLimit, 5);
  assert.equal(body.sellerSuggestedSupportContact, "owner@example.test");
  assert.equal("walletBalance" in body, false);
});

test("Commerce Admin explains that only the Discord guild owner can begin seller onboarding", async () => {
  const routes = createCommerceAdminRoutes({
    services: services(null),
    discordBotToken: "token",
    readCustomerAdminSession: sellerSession,
    isGuildOwner: async () => false,
  });
  const route = routes.find(
    (candidate) => candidate.method === "GET" && candidate.path === "/admin/api/commerce",
  );
  assert.ok(route);
  const response = await route.handler({
    request: new Request("https://example.test/admin/api/commerce?guildId=guild-1"),
    url: new URL("https://example.test/admin/api/commerce?guildId=guild-1"),
    params: {},
    query: { guildId: "guild-1" },
    body: undefined,
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error:
      "Only this Discord server's owner can set up Commerce. Ask the owner to open this page and submit the Stripe seller request.",
  });
});

test("Commerce sales panel routes require seller capability and preserve guild scope", async () => {
  const configured = services({ id: "account-1", guildId: "guild-1" });
  let received: Record<string, unknown> | undefined;
  const panel: CommerceSalesPanel = {
    connectedAccountId: "account-1",
    guildId: "guild-1",
    channelId: "channel-1",
    title: "Join our community",
    description: "Pick the access that works for you.",
    messageId: "message-1",
    lastErrorCode: null,
    createdAtMs: 1,
    updatedAtMs: 2,
  };
  configured.salesPanel = {
    async read() {
      return panel;
    },
    async publish(input) {
      received = input;
      return panel;
    },
    async unpublish() {
      return { ...panel, messageId: null };
    },
    async removeForOffboarding() {
      return { ...panel, messageId: null };
    },
    async refreshForGuild() {
      return panel;
    },
  };
  const routes = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "token",
    readCustomerAdminSession: sellerSession,
  });
  const publish = routes.find(
    (candidate) => candidate.path === "/admin/api/commerce/panel/publish",
  );
  assert.ok(publish);
  const response = await publish.handler({
    request: new Request("https://example.test/admin/api/commerce/panel/publish"),
    url: new URL("https://example.test/admin/api/commerce/panel/publish"),
    params: {},
    query: undefined,
    body: {
      guildId: "guild-1",
      channelId: "channel-1",
      title: "Join our community",
      description: "Pick the access that works for you.",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    connectedAccountId: "account-1",
    guildId: "guild-1",
    channelId: "channel-1",
    title: "Join our community",
    description: "Pick the access that works for you.",
  });

  configured.store.readSellerProfile = async () =>
    ({
      connectedAccountId: "account-1",
      guildId: "guild-1",
      sellerOwnerUserId: "another-user",
    }) as Awaited<ReturnType<CommerceAdminServices["store"]["readSellerProfile"]>>;
  const denied = await publish.handler({
    request: new Request("https://example.test/admin/api/commerce/panel/publish"),
    url: new URL("https://example.test/admin/api/commerce/panel/publish"),
    params: {},
    query: undefined,
    body: {
      guildId: "guild-1",
      channelId: "channel-1",
      title: "Join our community",
      description: "Pick the access that works for you.",
    },
  });
  assert.equal(denied.status, 403);
});

test("Commerce Admin saves branding for the connected guild and rejects another guild", async () => {
  const configured = services({ id: "account-1", guildId: "guild-1" });
  const saved: unknown[] = [];
  let reset = false;
  configured.store.readConnectedAccountByGuild = async (guildId) =>
    guildId === "guild-1"
      ? ({ id: "account-1", guildId: "guild-1" } as Awaited<
          ReturnType<CommerceAdminServices["store"]["readConnectedAccountByGuild"]>
        >)
      : null;
  configured.branding = {
    async readByGuild() {
      return null;
    },
    async save(input) {
      saved.push(input);
      return {
        guildId: input.guildId,
        connectedAccountId: input.connectedAccountId,
        accentColor: input.accentColor,
        tagline: input.tagline,
        createdByUserId: input.actorUserId,
        updatedByUserId: input.actorUserId,
        createdAtMs: input.nowMs,
        updatedAtMs: input.nowMs,
      };
    },
    async reset() {
      reset = true;
    },
  };
  const routes = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "token",
    readCustomerAdminSession: sellerSession,
  });
  const saveRoute = routes.find((candidate) => candidate.path === "/admin/api/commerce/branding");
  const resetRoute = routes.find(
    (candidate) => candidate.path === "/admin/api/commerce/branding/reset",
  );
  assert.ok(saveRoute);
  assert.ok(resetRoute);
  const request = new Request("https://example.test/admin/api/commerce/branding", {
    method: "POST",
  });
  const response = await saveRoute.handler({
    request,
    url: new URL(request.url),
    params: {},
    query: undefined,
    body: { guildId: "guild-1", accentColor: 0x12abef, tagline: " Welcome " },
  });
  assert.equal(response.status, 200);
  const savedInput = saved[0] as { guildId: string; tagline: string };
  assert.equal(savedInput.guildId, "guild-1");
  assert.equal(savedInput.tagline, "Welcome");

  await resetRoute.handler({
    request,
    url: new URL(request.url),
    params: {},
    query: undefined,
    body: { guildId: "guild-1" },
  });
  assert.equal(reset, true);
  await assert.rejects(
    async () =>
      await saveRoute.handler({
        request,
        url: new URL(request.url),
        params: {},
        query: undefined,
        body: { guildId: "guild-2", accentColor: 0x12abef, tagline: "No" },
      }),
    /Commerce seller is not connected/,
  );
});

test("Commerce Admin rejects cross-guild offering substitution before mutation", async () => {
  let published = false;
  const account = {
    id: "account-1",
    guildId: "guild-1",
  };
  const configured = services(account);
  configured.catalog.readOffering = async () =>
    ({
      id: "offering-1",
      connectedAccountId: "account-2",
      guildId: "guild-2",
    }) as CommerceOffering;
  configured.offerings.publish = async () => {
    published = true;
    throw new Error("should not run");
  };
  const route = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "token",
  }).find((candidate) => candidate.path.endsWith("/offerings/publish"));
  assert.ok(route);
  await assert.rejects(
    async () =>
      await route.handler({
        request: new Request("https://example.test/admin/api/commerce/offerings/publish"),
        url: new URL("https://example.test/admin/api/commerce/offerings/publish"),
        params: {},
        query: undefined,
        body: { guildId: "guild-1", offeringId: "offering-1" },
      }),
    /scope mismatch/,
  );
  assert.equal(published, false);
});

test("Commerce Admin saves policy-bounded one-time support configuration", async () => {
  let saved: Record<string, unknown> | null = null;
  const configured = services({ id: "account-1", guildId: "guild-1" });
  configured.support = {
    async page() {
      throw new Error("not configured");
    },
    async readReport() {
      return [];
    },
    async saveConfig(input) {
      saved = input;
      return input as never;
    },
    async refund() {
      return { refundId: "re_1" };
    },
  };
  const route = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "token",
    readCustomerAdminSession: sellerSession,
  }).find((candidate) => candidate.path === "/admin/api/commerce/support");
  assert.ok(route);
  const response = await route.handler({
    request: new Request("https://example.test/admin/api/commerce/support"),
    url: new URL("https://example.test/admin/api/commerce/support"),
    params: {},
    query: undefined,
    body: {
      guildId: "guild-1",
      enabled: true,
      explanation: "Helps cover ordinary tools and services used to operate this community.",
      currency: "AUD",
      suggestedAmountsMinor: [500, 1_000, 2_000],
      supportContact: "seller@example.test",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(saved, {
    guildId: "guild-1",
    enabled: true,
    explanation: "Helps cover ordinary tools and services used to operate this community.",
    currency: "AUD",
    suggestedAmountsMinor: [500, 1_000, 2_000],
    supportContact: "seller@example.test",
  });
});

test("Commerce Admin financial actions carry the authenticated seller owner", async () => {
  type RefundInput = Parameters<
    NonNullable<CommerceAdminServices["financialOperations"]>["refundSubscription"]
  >[0];
  let received: RefundInput | undefined;
  const configured = services({ id: "account-1", guildId: "guild-1" });
  configured.financialOperations = {
    async refundSubscription(input: RefundInput) {
      received = input;
      return { refundId: "re_1", accessAction: "remove_immediately" };
    },
  } as unknown as NonNullable<CommerceAdminServices["financialOperations"]>;
  configured.safeguards = {
    async readDashboard() {
      return null;
    },
    async setControl(input) {
      return input as never;
    },
  };
  const route = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "token",
    readCustomerAdminSession: sellerSession,
  }).find((candidate) => candidate.path === "/admin/api/commerce/financial/refund");
  assert.ok(route);
  const response = await route.handler({
    request: new Request("https://example.test/admin/api/commerce/financial/refund", {
      headers: { "Idempotency-Key": "refund-request-1" },
    }),
    url: new URL("https://example.test/admin/api/commerce/financial/refund"),
    params: {},
    query: undefined,
    body: {
      guildId: "guild-1",
      paymentId: "payment-1",
      amountMinor: 1_000,
      cancellation: "default",
      reasonCode: "buyer_request",
    },
  });
  assert.equal(response.status, 202);
  assert.ok(received);
  assert.equal(received.actorUserId, "operator-1");
  assert.equal(received.reasonCode, "buyer_request");
  assert.equal(received.actionId, "refund-request-1");
});

test("Commerce offboarding removes the panel projection before seller archival", async () => {
  const calls: string[] = [];
  const configured = services({ id: "account-1", guildId: "guild-1" });
  configured.salesPanel = {
    async removeForOffboarding() {
      calls.push("panel-cleanup");
      return null;
    },
  } as unknown as NonNullable<CommerceAdminServices["salesPanel"]>;
  configured.financialOperations = {
    async completeOffboarding() {
      calls.push("seller-archive");
    },
  } as unknown as NonNullable<CommerceAdminServices["financialOperations"]>;
  const route = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "token",
    readCustomerAdminSession: sellerSession,
  }).find((candidate) => candidate.path === "/admin/api/commerce/offboarding/complete");
  assert.ok(route);
  const request = () => ({
    request: new Request("https://example.test/admin/api/commerce/offboarding/complete", {
      headers: { "Idempotency-Key": "offboarding-complete-1" },
    }),
    url: new URL("https://example.test/admin/api/commerce/offboarding/complete"),
    params: {},
    query: undefined,
    body: { guildId: "guild-1", reasonCode: "seller_requested" },
  });
  assert.equal((await route.handler(request())).status, 200);
  assert.deepEqual(calls, ["panel-cleanup", "seller-archive"]);

  calls.length = 0;
  configured.salesPanel.removeForOffboarding = async () => {
    calls.push("panel-cleanup-failed");
    throw new Error("commerce_sales_panel_delete_failed");
  };
  await assert.rejects(async () => route.handler(request()), /commerce_sales_panel_delete_failed/);
  assert.deepEqual(calls, ["panel-cleanup-failed"]);
});

test("Commerce Admin audits renewal shutdown and schedules period-end cancellation", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const configured = services({ id: "account-1", guildId: "guild-1" });
  type ControlInput = Parameters<NonNullable<CommerceAdminServices["safeguards"]>["setControl"]>[0];
  type RenewalInput = Parameters<
    NonNullable<CommerceAdminServices["financialOperations"]>["shutdownRenewals"]
  >[0];
  configured.safeguards = {
    async readDashboard() {
      return null;
    },
    async setControl(input: ControlInput) {
      calls.push({ kind: "control", ...input });
      return input as never;
    },
  };
  configured.financialOperations = {
    async shutdownRenewals(input: RenewalInput) {
      calls.push({ kind: "renewals", ...input });
      return { subscriptions: [] };
    },
  } as unknown as NonNullable<CommerceAdminServices["financialOperations"]>;
  const route = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "token",
    readCustomerAdminSession: sellerSession,
  }).find((candidate) => candidate.path === "/admin/api/commerce/safeguards/control");
  assert.ok(route);
  const response = await route.handler({
    request: new Request("https://example.test/admin/api/commerce/safeguards/control", {
      headers: { "Idempotency-Key": "renewal-shutdown-1" },
    }),
    url: new URL("https://example.test/admin/api/commerce/safeguards/control"),
    params: {},
    query: undefined,
    body: {
      guildId: "guild-1",
      scopeType: "guild",
      controlType: "renewal_shutdown",
      enabled: true,
      reasonCode: "elevated_disputes",
    },
  });
  assert.equal(response.status, 200);
  assert.equal(calls[0]?.actorUserId, "operator-1");
  assert.equal(calls[1]?.kind, "renewals");
  assert.equal(calls[1]?.reasonCode, "elevated_disputes");
  assert.equal(calls[1]?.actionId, "renewal-shutdown-1");
});

test("Commerce Admin retirement carries actor, reason, and stable action identity", async () => {
  let received: Record<string, unknown> | undefined;
  const configured = services({ id: "account-1", guildId: "guild-1" });
  configured.catalog.readOffering = async () =>
    ({
      id: "b7e7ee4d-94a5-46bc-ac4a-0605ab0659d2",
      connectedAccountId: "account-1",
      guildId: "guild-1",
    }) as CommerceOffering;
  configured.offerings.retire = async (input: unknown) => {
    received = input as Record<string, unknown>;
    return { state: "retiring" } as never;
  };
  const route = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "token",
    readCustomerAdminSession: sellerSession,
  }).find((candidate) => candidate.path === "/admin/api/commerce/offerings/retire");
  assert.ok(route);

  const response = await route.handler({
    request: new Request("https://example.test/admin/api/commerce/offerings/retire", {
      headers: { "Idempotency-Key": "retire-request-1" },
    }),
    url: new URL("https://example.test/admin/api/commerce/offerings/retire"),
    params: {},
    query: undefined,
    body: {
      guildId: "guild-1",
      offeringId: "b7e7ee4d-94a5-46bc-ac4a-0605ab0659d2",
      reasonCode: "seller_requested",
    },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(received, {
    offeringId: "b7e7ee4d-94a5-46bc-ac4a-0605ab0659d2",
    actorUserId: "operator-1",
    reasonCode: "seller_requested",
    actionId: "retire-request-1",
  });
});

test("Commerce Admin exposes guild-scoped financial action status", async () => {
  const configured = services({ id: "account-1", guildId: "guild-1" });
  configured.financialOperations = {
    async readActionForGuild(actionId: string, actionGuildId: string) {
      assert.equal(actionId, "refund-request-1");
      assert.equal(actionGuildId, "guild-1");
      return { id: actionId, guildId: actionGuildId, status: "processing" } as never;
    },
  } as unknown as NonNullable<CommerceAdminServices["financialOperations"]>;
  const route = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "token",
    readCustomerAdminSession: sellerSession,
  }).find((candidate) => candidate.path === "/admin/api/commerce/financial/action");
  assert.ok(route);

  const response = await route.handler({
    request: new Request(
      "https://example.test/admin/api/commerce/financial/action?guildId=guild-1&actionId=refund-request-1",
    ),
    url: new URL(
      "https://example.test/admin/api/commerce/financial/action?guildId=guild-1&actionId=refund-request-1",
    ),
    params: {},
    query: { guildId: "guild-1", actionId: "refund-request-1" },
    body: undefined,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    action: { id: "refund-request-1", guildId: "guild-1", status: "processing" },
  });
});

test("ordinary Guild admins have no implicit Commerce finance authority", async () => {
  let refunded = false;
  const configured = services({ id: "account-1", guildId: "guild-1" });
  configured.financialOperations = {
    async refundSubscription() {
      refunded = true;
      return { refundId: "re_1", accessAction: "retain" };
    },
  } as unknown as NonNullable<CommerceAdminServices["financialOperations"]>;
  const route = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "token",
    readCustomerAdminSession: async () => ({
      user: { id: "session-admin", discordUserId: "ordinary-admin", name: "Admin" },
    }),
  }).find((candidate) => candidate.path === "/admin/api/commerce/financial/refund");
  assert.ok(route);
  assert.deepEqual(route.access, { mode: "write", customerSessionOnly: true });
  const response = await route.handler({
    request: new Request("https://example.test/admin/api/commerce/financial/refund", {
      headers: { "Idempotency-Key": "finance-manager-refund-1" },
    }),
    url: new URL("https://example.test/admin/api/commerce/financial/refund"),
    params: {},
    query: undefined,
    body: {
      guildId: "guild-1",
      paymentId: "payment-1",
      amountMinor: 100,
      cancellation: "none",
      reasonCode: "buyer_request",
    },
  });
  assert.equal(response.status, 403);
  assert.equal(refunded, false);
});

test("an explicitly granted finance manager can refund without seller-management authority", async () => {
  let actorUserId = "";
  const configured = services({ id: "account-1", guildId: "guild-1" });
  configured.store.readSellerCapabilities = async (_accountId, userId) =>
    userId === "finance-manager" ? ["commerce.finance.refund"] : [];
  configured.financialOperations = {
    async refundSubscription(
      input: Parameters<
        NonNullable<CommerceAdminServices["financialOperations"]>["refundSubscription"]
      >[0],
    ) {
      actorUserId = input.actorUserId;
      return { refundId: "re_1", accessAction: "retain" };
    },
  } as unknown as NonNullable<CommerceAdminServices["financialOperations"]>;
  configured.safeguards = {
    async readDashboard() {
      return null;
    },
    async setControl(input) {
      return input as never;
    },
  };
  const routes = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "token",
    readCustomerAdminSession: async () => ({
      user: { id: "session-manager", discordUserId: "finance-manager", name: "Manager" },
    }),
    isPlatformOperator: async () => false,
  });
  const refund = routes.find(
    (candidate) => candidate.path === "/admin/api/commerce/financial/refund",
  );
  assert.ok(refund);
  const response = await refund.handler({
    request: new Request("https://example.test/admin/api/commerce/financial/refund", {
      headers: { "Idempotency-Key": "finance-manager-refund-1" },
    }),
    url: new URL("https://example.test/admin/api/commerce/financial/refund"),
    params: {},
    query: undefined,
    body: {
      guildId: "guild-1",
      paymentId: "payment-1",
      amountMinor: 100,
      cancellation: "none",
      reasonCode: "buyer_request",
    },
  });
  assert.equal(response.status, 202);
  assert.equal(actorUserId, "finance-manager");

  const platformControl = routes.find(
    (candidate) => candidate.path === "/admin/api/platform/commerce/controls",
  );
  assert.ok(platformControl);
  assert.equal(
    (
      await platformControl.handler({
        request: new Request("https://example.test/admin/api/platform/commerce/controls"),
        url: new URL("https://example.test/admin/api/platform/commerce/controls"),
        params: {},
        query: undefined,
        body: {
          actionId: "unauthorized-control",
          controlType: "commerce_kill",
          enabled: true,
          reasonCode: "pilot_pause",
        },
      })
    ).status,
    403,
  );
});

test("seller onboarding derives owner identity and can retry without another account", async () => {
  const calls: Array<
    Parameters<NonNullable<CommerceAdminServices["sellerLifecycle"]>["beginOnboarding"]>[0]
  > = [];
  const configured = services(null);
  configured.sellerLifecycle = {
    async beginOnboarding(
      input: Parameters<
        NonNullable<CommerceAdminServices["sellerLifecycle"]>["beginOnboarding"]
      >[0],
    ) {
      calls.push(input);
      return {
        account: { id: "account-1" },
        onboardingUrl: "https://connect.stripe.test/onboarding",
      } as never;
    },
  } as unknown as NonNullable<CommerceAdminServices["sellerLifecycle"]>;
  const ownerRoutes = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "token",
    publicBaseUrl: "https://haf.test",
    readCustomerAdminSession: async () => ({
      user: {
        id: "session-1",
        discordUserId: "operator-1",
        name: "Operator",
        email: "owner@example.test",
      },
    }),
    isGuildOwner: async (_guildId, userId) => userId === "operator-1",
  });
  const connect = ownerRoutes.find(
    (candidate) => candidate.path === "/admin/api/commerce/seller/connect",
  );
  assert.ok(connect);
  const input = {
    guildId: "111111111111111111",
    supportContact: "seller@example.test",
    adultAttested: true as const,
    twoFactorEvidence: "seller_attested" as const,
    termsAccepted: true as const,
    sellerAcknowledged: true as const,
    feesAcknowledged: true as const,
  };
  const response = await connect.handler({
    request: new Request("https://haf.test/admin/api/commerce/seller/connect"),
    url: new URL("https://haf.test/admin/api/commerce/seller/connect"),
    params: {},
    query: undefined,
    body: input,
  });
  assert.equal(response.status, 201);
  assert.equal(calls[0]?.sellerUserId, "operator-1");
  assert.equal(calls[0]?.ownerAuthorized, true);
  assert.equal(calls[0]?.sellerEmail, "owner@example.test");
  assert.equal(calls[0]?.businessProfileUrl, "https://haf.test/commerce/stores/111111111111111111");

  const deniedRoutes = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "token",
    publicBaseUrl: "https://haf.test",
    readCustomerAdminSession: sellerSession,
    isGuildOwner: async () => false,
  });
  const denied = deniedRoutes.find(
    (candidate) => candidate.path === "/admin/api/commerce/seller/connect",
  );
  assert.ok(denied);
  assert.equal(
    (
      await denied.handler({
        request: new Request("https://haf.test/admin/api/commerce/seller/connect"),
        url: new URL("https://haf.test/admin/api/commerce/seller/connect"),
        params: {},
        query: undefined,
        body: input,
      })
    ).status,
    403,
  );
  assert.equal(calls.length, 1);
});

test("only platform operators can approve sellers and set global controls", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const configured = services({ id: "account-1", guildId: "guild-1" });
  configured.store.listSellerProfiles = async () => [
    {
      connectedAccountId: "account-1",
      guildId: "guild-1",
    } as Awaited<ReturnType<CommerceAdminServices["store"]["listSellerProfiles"]>>[number],
  ];
  configured.sellerLifecycle = {
    async reviewSeller(
      input: Parameters<NonNullable<CommerceAdminServices["sellerLifecycle"]>["reviewSeller"]>[0],
    ) {
      calls.push({ kind: "review", ...input });
      return { approvalState: input.approvalState } as never;
    },
  } as unknown as NonNullable<CommerceAdminServices["sellerLifecycle"]>;
  configured.safeguards = {
    async readDashboard() {
      return null;
    },
    async setControl(input) {
      calls.push({ kind: "control", ...input });
      return input as never;
    },
  };
  configured.financialOperations = {
    async shutdownRenewals(
      input: Parameters<
        NonNullable<CommerceAdminServices["financialOperations"]>["shutdownRenewals"]
      >[0],
    ) {
      calls.push({ kind: "renewals", ...input });
      return { subscriptions: [] };
    },
  } as unknown as NonNullable<CommerceAdminServices["financialOperations"]>;
  const routes = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "token",
    readCustomerAdminSession: sellerSession,
    isPlatformOperator: async (userId) => userId === "operator-1",
  });
  const approve = routes.find(
    (candidate) => candidate.path === "/admin/api/platform/commerce/sellers/approve",
  );
  assert.ok(approve);
  assert.equal(
    (
      await approve.handler({
        request: new Request("https://haf.test/admin/api/platform/commerce/sellers/approve"),
        url: new URL("https://haf.test/admin/api/platform/commerce/sellers/approve"),
        params: {},
        query: undefined,
        body: { guildId: "guild-1", reasonCode: "pilot_approved" },
      })
    ).status,
    200,
  );
  const control = routes.find(
    (candidate) => candidate.path === "/admin/api/platform/commerce/controls",
  );
  assert.ok(control);
  assert.equal(
    (
      await control.handler({
        request: new Request("https://haf.test/admin/api/platform/commerce/controls"),
        url: new URL("https://haf.test/admin/api/platform/commerce/controls"),
        params: {},
        query: undefined,
        body: {
          actionId: "global-control-1",
          controlType: "commerce_kill",
          enabled: true,
          reasonCode: "pilot_pause",
        },
      })
    ).status,
    200,
  );
  assert.equal(calls.find((call) => call.kind === "control")?.scopeType, "global");
  assert.equal(calls.find((call) => call.kind === "control")?.scopeId, "commerce");
  assert.equal(calls.filter((call) => call.kind === "renewals").length, 1);
  assert.equal(
    calls.find((call) => call.kind === "renewals")?.actionId,
    "commerce:global-control:global-control-1:account-1",
  );
});

function services(account: { id: string; guildId: string } | null): CommerceAdminServices {
  return {
    store: {
      async readConnectedAccountByGuild() {
        return account as Awaited<
          ReturnType<CommerceAdminServices["store"]["readConnectedAccountByGuild"]>
        >;
      },
      async readSellerProfile() {
        return account
          ? ({
              connectedAccountId: account.id,
              guildId: account.guildId,
              sellerOwnerUserId: "operator-1",
            } as Awaited<ReturnType<CommerceAdminServices["store"]["readSellerProfile"]>>)
          : null;
      },
      async readSellerAcceptance() {
        return null;
      },
      async readSellerCapabilities() {
        return [];
      },
      async saveAuthorityGrant() {},
      async listSellerProfiles() {
        return [];
      },
      async appendOperation() {
        return true;
      },
    },
    catalog: {
      async readOffering() {
        return null;
      },
    } as unknown as CommerceAdminServices["catalog"],
    offerings: {
      async dashboard() {
        return { seller: null, offerings: [], estimatedProceedsAreNonAuthoritative: true };
      },
    } as unknown as CommerceAdminServices["offerings"],
    currentTermsVersion: "seller-terms-2026-07",
  };
}

async function sellerSession() {
  return {
    user: {
      id: "session-1",
      discordUserId: "operator-1",
      name: "Operator",
      email: "owner@example.test",
    },
  };
}

test("reserved-access configuration and repair require separate current seller capabilities", async () => {
  const configured = services({ id: "account-1", guildId: "guild-1" });
  configured.store.readSellerCapabilities = async () => [];
  const routes = createCommerceAdminRoutes({
    services: configured,
    discordBotToken: "fixture",
    readCustomerAdminSession: async () => ({
      user: { id: "session-outsider", discordUserId: "outsider", name: "Outsider" },
    }),
  });
  for (const path of ["configure", "repair"]) {
    const route = routes.find((r) => r.path === `/admin/api/commerce/game-access/${path}`);
    assert.ok(route);
    assert.deepEqual(route.access, { mode: "write", customerSessionOnly: true });
    const response = await route.handler({
      request: new Request(`https://example.test/admin/api/commerce/game-access/${path}`),
      url: new URL("https://example.test"),
      params: {},
      query: undefined,
      body: {
        guildId: "guild-1",
        offeringId: "offering",
        targetId: "target",
        allocationCeiling: 1,
        acceptingSales: false,
        id: "assignment",
        reason: "Review reservation",
      },
    });
    assert.equal(response.status, 403);
  }
});
