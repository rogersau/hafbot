import { adminErrorResponse } from "./support/admin-error-response";
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { managedMessagesClient } from "../src/admin/generated/admin-client/managed-messages";
import {
  AdminContractViolationError,
  callAdminContract,
} from "../src/admin/generated/admin-client/core";
import { ticketsClient } from "../src/admin/generated/admin-client/tickets";
import { webhookProxyClient } from "../src/admin/generated/admin-client/webhook-proxy";
import { eventsClient } from "../src/admin/generated/admin-client/events";
import { playerCountClient } from "../src/admin/generated/admin-client/player-count";
import { playerLinkClient } from "../src/admin/generated/admin-client/player-link";
import { billingClient } from "../src/admin/generated/admin-client/billing";
import { crossCuttingClient } from "../src/admin/generated/admin-client/cross-cutting";
import { AdminApiError, parseAdminApiError } from "../src/admin/lib/api";
import { adminErrorEnvelopeSchema } from "../src/contracts/admin/errors";
import type { AdminOperationContract } from "../src/contracts/admin/core";

test("managed message contract serializes query and body and validates a round trip", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    requests.push({ input: String(input), init });
    if (init?.method === "POST")
      return Response.json({
        message: {
          id: "message",
          guildId: "guild 1",
          internalName: "Rules",
          channelId: "channel",
          messageId: "discord-message",
          embeds: [{ description: "Hello", fields: [] }],
          announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
          status: "published",
          createdAtMs: 1,
          updatedAtMs: 1,
        },
      });
    return Response.json({ canWrite: true, serverOnly: "accepted but stripped by the client" });
  };

  assert.deepEqual(
    await managedMessagesClient.capabilities({ guildId: "guild 1", workspaceId: "workspace" }),
    { canWrite: true },
  );
  assert.equal(
    requests[0]?.input,
    "/admin/api/managed-messages/capabilities?guildId=guild+1&workspaceId=workspace",
  );
  await managedMessagesClient.save({
    guildId: "guild 1",
    internalName: "Rules",
    channelId: "channel",
    embeds: [{ description: "Hello", fields: [] }],
    announcement: { roleIds: [], everyone: false, here: false, notifyOnCreate: false },
    clientOnly: "stripped before sending",
  } as Parameters<typeof managedMessagesClient.save>[0] & { clientOnly: string });
  assert.equal(requests[1]?.input, "/admin/api/managed-messages");
  assert.equal(JSON.parse(String(requests[1]?.init?.body)).guildId, "guild 1");
  assert.equal(JSON.parse(String(requests[1]?.init?.body)).clientOnly, undefined);
});

test("managed message client rejects malformed successful responses with the operation ID", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => Response.json({ canWrite: "yes" });
  await assert.rejects(
    managedMessagesClient.capabilities({ guildId: "guild" }),
    /Invalid response for managedMessagesCapabilities\.get/,
  );
});

test("managed message client exposes the stable Admin error envelope", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    adminErrorResponse("Fix the highlighted fields.", 400, {
      code: "invalid_request",
      correlationId: "corr-1",
      retryable: false,
      action: "fix_fields",
      fieldIssues: [{ path: "channelId", code: "too_small", message: "Required" }],
    });
  await assert.rejects(managedMessagesClient.capabilities({ guildId: "guild" }), (error) => {
    assert.ok(error instanceof AdminApiError);
    assert.equal(error.code, "invalid_request");
    assert.equal(error.correlationId, "corr-1");
    assert.equal(error.fieldIssues?.[0]?.path, "channelId");
    return true;
  });
});

test("generated clients reject malformed Admin error envelopes", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () => Response.json({ error: "Invalid response" }, { status: 400 });
  await assert.rejects(
    ticketsClient.panel({ guildId: "guild" }),
    (error) =>
      error instanceof AdminContractViolationError &&
      /malformed Admin error envelope/.test(error.message),
  );
});

test("Admin API clients parse only bounded stale-preview reasons", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  globalThis.fetch = async () =>
    adminErrorResponse("Discord channel state changed after preview.", 409, {
      code: "stale_preview",
      correlationId: "corr-stale",
      retryable: false,
      staleReason: "source",
    });
  const contract = {
    operationId: "test.stalePreview",
    method: "POST",
    path: "/admin/api/test",
    summary: "Test stale preview",
    tags: ["Test"],
    success: { status: 200, schema: z.object({ ok: z.boolean() }), description: "Success" },
    errors: [
      {
        status: 409,
        codes: ["stale_preview"],
        description: "Preview is stale",
        schema: adminErrorEnvelopeSchema,
      },
    ],
    access: { mode: "write", scope: "guild" },
    feature: undefined,
    entitlement: undefined,
  } as const satisfies AdminOperationContract;
  await assert.rejects(callAdminContract(contract), (error) => {
    assert.ok(error instanceof AdminApiError);
    assert.equal(error.code, "stale_preview");
    assert.equal(error.staleReason, "source");
    return true;
  });

  const malformed = await parseAdminApiError(
    adminErrorResponse("Discord channel state changed after preview.", 409, {
      code: "stale_preview",
      correlationId: "corr-stale",
      retryable: false,
      staleReason: "raw-provider-detail" as never,
    }),
    "Conflict",
  );
  assert.equal(malformed.code, "internal_error");
  assert.equal(malformed.staleReason, undefined);
});

test("generated Tickets client serializes pagination and validates responses", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requested = "";
  globalThis.fetch = async (input) => {
    requested = String(input);
    return Response.json({ tickets: [], total: 0, nextCursor: null });
  };
  assert.deepEqual(
    await ticketsClient.closed({
      guildId: "guild 1",
      workspaceId: "workspace",
      panelId: "main",
      limit: "20",
      beforeOpenedAtMs: "1700000000000",
    }),
    { tickets: [], total: 0, nextCursor: null },
  );
  assert.equal(
    requested,
    "/admin/api/tickets/closed?guildId=guild+1&workspaceId=workspace&panelId=main&limit=20&beforeOpenedAtMs=1700000000000",
  );
});

test("generated Tickets client rejects modal fields that exceed current write limits", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  const invalidQuestion = {
    id: "q".repeat(101),
    label: "L".repeat(46),
    style: "short" as const,
    placeholder: "P".repeat(101),
    required: true,
  };
  const panel = {
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
    ticketTypes: [
      {
        id: "support",
        label: "Support",
        emoji: null,
        buttonStyle: "primary" as const,
        supportRoleId: "role-1",
        channelNamePrefix: "support",
        questions: [invalidQuestion],
        participantManagementEnabled: false,
        limitExclusion: false,
        responseRules: [],
      },
    ],
  };
  globalThis.fetch = async () => Response.json({ panel, panels: [panel] });

  await assert.rejects(ticketsClient.panel({ guildId: "guild-1" }), AdminContractViolationError);
});

test("generated Webhook Proxy client serializes configuration and validates the response", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let request: { input: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init };
    return Response.json({ ok: true, publicId: "public-webhook-id" });
  };

  const result = await webhookProxyClient.save({
    guildId: "guild",
    workspaceId: "workspace",
    name: "Alerts",
    enabled: true,
    banLookupEnabled: false,
    banLookupCredential: { action: "clear" },
    banLookupAppIds: [],
    destinations: [
      {
        id: "main",
        label: "Main",
        credential: { action: "replace", url: "https://discord.com/api/webhooks/123456/token" },
      },
    ],
    defaultDestinationIds: ["main"],
    routingRules: [],
    contentReplacements: [],
  });

  assert.deepEqual(result, { ok: true, publicId: "public-webhook-id" });
  assert.equal(request?.input, "/admin/api/webhook-proxy/config");
  assert.equal(JSON.parse(String(request?.init?.body)).workspaceId, "workspace");
});

test("generated clients reject an undeclared Webhook Proxy error code and emit safe telemetry", async (t) => {
  const originalFetch = globalThis.fetch;
  const originalDispatchEvent = globalThis.dispatchEvent;
  t.after(() => {
    globalThis.fetch = originalFetch;
    globalThis.dispatchEvent = originalDispatchEvent;
  });
  let telemetry: unknown;
  globalThis.dispatchEvent = ((event: Event) => {
    telemetry = (event as CustomEvent).detail;
    return true;
  }) as typeof globalThis.dispatchEvent;
  globalThis.fetch = async () =>
    adminErrorResponse("Unexpected", 400, {
      code: "provider_unavailable",
      correlationId: "corr-webhook",
      retryable: true,
    });

  await assert.rejects(
    webhookProxyClient.get({ guildId: "guild" }),
    /undeclared error code provider_unavailable/,
  );
  assert.deepEqual(telemetry, {
    operationId: "webhookProxy.get",
    status: 400,
    code: "provider_unavailable",
    correlationId: "corr-webhook",
  });
});

test("generated Events client serializes template requests and validates the response", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let request: { input: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init };
    return Response.json({
      template: {
        guildId: "guild",
        id: "template-1",
        name: "Weekly raid",
        description: "Raid roster",
        signupMode: "single_choice",
        participationMode: "individual",
        requiredTeamSize: null,
        threadEnabled: false,
        waitlistedMembersJoinThread: false,
        groups: [
          {
            id: "main",
            label: "Main group",
            emoji: null,
            capacity: 10,
            waitlistEnabled: true,
            allowedRoleIds: [],
            blockedRoleIds: [],
            grantRoleId: null,
          },
        ],
        reminders: [],
        createdAtMs: 1,
        updatedAtMs: 1,
      },
    });
  };

  const result = await eventsClient.createTemplate({
    guildId: "guild",
    workspaceId: "workspace",
    name: "Weekly raid",
    groups: [{ id: "main", label: "Main group", capacity: 10 }],
  });

  assert.equal(result.template.id, "template-1");
  assert.equal(request?.input, "/admin/api/events/templates");
  assert.equal(JSON.parse(String(request?.init?.body)).workspaceId, "workspace");
});

test("generated Events client serializes a guild-scoped roster export", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let request = "";
  globalThis.fetch = async (input) => {
    request = String(input);
    return Response.json({ filename: "raid-roster.csv", csv: "participant_id\nuser-1\n" });
  };

  const result = await eventsClient.exportRoster({
    guildId: "guild 1",
    workspaceId: "workspace",
    eventId: "event 1",
  });

  assert.equal(result.filename, "raid-roster.csv");
  assert.equal(
    request,
    "/admin/api/events/roster-export?guildId=guild+1&workspaceId=workspace&eventId=event+1",
  );
});

test("generated Player Count client serializes a server test request", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let request = "";
  globalThis.fetch = async (input) => {
    request = String(input);
    return Response.json({ ok: true, snapshot: { count: 3, maxSlots: 20, queue: 0 } });
  };

  const result = await playerCountClient.test({
    guildId: "guild",
    workspaceId: "workspace",
    serverId: "server-1",
  });
  assert.deepEqual(result, { ok: true, snapshot: { count: 3, maxSlots: 20, queue: 0 } });
  assert.equal(request, "/admin/api/player-count/test");
});

test("generated Billing client serializes checkout and validates the hosted URL", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let request: { input: string; init?: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), init };
    return Response.json({ checkoutSessionId: "cs_1", url: "https://checkout.example" });
  };

  const result = await billingClient.checkout({ priceId: "price_1", intentId: "intent_123" });
  assert.deepEqual(result, { checkoutSessionId: "cs_1", url: "https://checkout.example" });
  assert.equal(request?.input, "/admin/api/billing/checkout");
  assert.deepEqual(JSON.parse(String(request?.init?.body)), {
    priceId: "price_1",
    intentId: "intent_123",
  });
});

test("generated cross-cutting client serializes Guild entitlement queries", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let requested = "";
  globalThis.fetch = async (input) => {
    requested = String(input);
    return Response.json({
      tier: "free",
      limits: {
        blocklistMaxEmojis: 10,
        reactionLimitsEnabled: true,
        ticketsMaxPanels: 1,
        ticketsMaxTypesPerPanel: 1,
        platformLinkMaxLinks: 100,
        managedMessagesMax: 3,
        clansMax: 5,
        clanMembersMax: 25,
        clanOfficersMax: 5,
        messageTemplatesMax: 3,
        evidenceVaultMaxRecords: 30,
        r2MaxBytes: 100,
        paidFeatures: false,
      },
      supportInvite: null,
      r2Usage: { usedBytes: 0, reservedBytes: 0, maxBytes: 100, lastReconciledAtMs: null },
    });
  };

  const result = await crossCuttingClient.entitlement({
    guildId: "guild 1",
    workspaceId: "workspace",
  });
  assert.equal(result.tier, "free");
  assert.equal(requested, "/admin/api/entitlement?guildId=guild+1&workspaceId=workspace");
});

test("generated Player Link client serializes platform configuration", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ ok: true });
  };

  await playerLinkClient.save({
    guildId: "guild",
    workspaceId: "workspace",
    platform: "xbox",
    panelTitle: "Link Xbox",
    panelDescription: "Link account",
    panelButtonLabel: "Link",
    panelButtonStyle: "Primary",
    allowRelink: false,
  });
  assert.equal(body?.guildId, "guild");
  assert.equal(body?.platform, "xbox");
});
