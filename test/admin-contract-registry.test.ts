import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  adminErrorEnvelopeSchema,
  adminOperationContracts,
  getAdminOperationContract,
  managedMessageContracts,
  messageTemplateContracts,
  ticketContracts,
  webhookProxyContracts,
  eventsContracts,
  playerCountContracts,
  playerLinkContracts,
  billingContracts,
  crossCuttingContracts,
  validateAdminOperationContracts,
  type AdminOperationContract,
} from "../src/contracts/admin";
import { createManagedMessageAdminRoutes } from "../src/runtime/admin-routes/managed-messages";
import { createMessageTemplateAdminRoutes } from "../src/runtime/admin-routes/message-templates";
import { createTicketAdminRoutes } from "../src/runtime/admin-routes/tickets";
import { createIntegrationsAdminRoutes } from "../src/runtime/admin-routes/integrations";
import { createEventsAdminRoutes } from "../src/runtime/admin-routes/events";
import { createUserProfileAdminRoutes } from "../src/runtime/admin-routes/profile";
import { createGuildFeaturesAdminRoutes } from "../src/runtime/admin-routes/guild-features";
import { createGuildOverviewAdminRoutes } from "../src/runtime/admin-routes/guild-overview";
import { createPermissionsAdminRoutes } from "../src/runtime/admin-routes/permissions";
import { createSocialAdminRoutes } from "../src/runtime/admin-routes/social";
import { createSpaAdminRoutes } from "../src/runtime/admin-routes/spa";

test("Admin operation registry is sorted, complete, and addressable by operation ID", () => {
  assert.deepEqual(
    adminOperationContracts.map(({ operationId }) => operationId),
    [...adminOperationContracts].map(({ operationId }) => operationId).sort(),
  );
  for (const contract of adminOperationContracts) {
    assert.equal(getAdminOperationContract(contract.operationId), contract);
    assert.ok(contract.summary);
    assert.ok(contract.tags.length > 0);
    assert.ok(contract.success.description);
    assert.ok(contract.errors.every(({ schema }) => schema === adminErrorEnvelopeSchema));
  }
  assert.equal(getAdminOperationContract("missing.get"), undefined);
});

test("Admin operation registry validation rejects duplicate IDs, routes, and unstable order", () => {
  const operation = (operationId: string, method = "GET", path = "/admin/api/example") =>
    ({
      operationId,
      method,
      path,
      summary: "Example",
      tags: ["Example"],
      success: { status: 200, schema: z.object({ ok: z.boolean() }), description: "Example" },
      errors: [
        {
          status: 500,
          codes: ["internal_error"],
          description: "Internal error",
          schema: adminErrorEnvelopeSchema,
        },
      ],
      access: { mode: "read", scope: "guild" },
      feature: undefined,
      entitlement: undefined,
    }) as AdminOperationContract;

  assert.throws(
    () => validateAdminOperationContracts([operation("example.get"), operation("example.get")]),
    /Duplicate admin operation ID/,
  );
  assert.throws(
    () =>
      validateAdminOperationContracts([
        operation("example.get"),
        operation("other.get", "GET", "/admin/api/example"),
      ]),
    /Duplicate admin operation route/,
  );
  assert.throws(
    () =>
      validateAdminOperationContracts([
        operation("zebra.get", "GET", "/admin/api/zebra"),
        operation("alpha.get", "GET", "/admin/api/alpha"),
      ]),
    /not sorted/,
  );
  assert.throws(
    () => validateAdminOperationContracts([operation("Invalid")]),
    /Invalid admin operation ID/,
  );
  assert.throws(
    () => validateAdminOperationContracts([operation("example.get", "OPTIONS")]),
    /Invalid admin operation method/,
  );
  assert.throws(
    () => validateAdminOperationContracts([operation("example.get", "GET", "/public/example")]),
    /Invalid admin operation path/,
  );
});

test("Managed Messages runtime routes bind every static contract and its response schemas", () => {
  const routes = createManagedMessageAdminRoutes({
    service: {} as never,
    mediaService: {} as never,
    discordBotToken: "token",
  });
  assert.deepEqual(
    routes.map(({ operationId }) => operationId).sort(),
    Object.values(managedMessageContracts)
      .map(({ operationId }) => operationId)
      .sort(),
  );
  for (const route of routes) {
    const contract = getAdminOperationContract(route.operationId!);
    assert.ok(contract);
    assert.equal(route.query, contract.query);
    assert.equal(route.body, contract.body);
    assert.equal(route.success, contract.success.schema);
    assert.equal(route.errors, adminErrorEnvelopeSchema);
  }
});

test("Message Templates and Tickets runtime routes bind every static contract", () => {
  const routes = [
    ...createMessageTemplateAdminRoutes({ service: {} as never }),
    ...createTicketAdminRoutes({} as never),
  ];
  assert.deepEqual(
    routes.map(({ operationId }) => operationId).sort(),
    [...Object.values(messageTemplateContracts), ...Object.values(ticketContracts)]
      .map(({ operationId }) => operationId)
      .sort(),
  );
  for (const route of routes) {
    const contract = getAdminOperationContract(route.operationId!);
    assert.ok(contract);
    assert.equal(route.success, contract.success.schema);
    assert.equal(route.errors, adminErrorEnvelopeSchema);
  }
});

test("Webhook Proxy runtime routes bind every static contract", () => {
  const routes = createIntegrationsAdminRoutes({
    stores: {} as never,
    adminAccess: {} as never,
    discordBotToken: "token",
  });
  const webhookRoutes = routes.filter(({ path }) => path.startsWith("/admin/api/webhook-proxy"));
  assert.deepEqual(
    webhookRoutes.map(({ operationId }) => operationId).sort(),
    Object.values(webhookProxyContracts)
      .map(({ operationId }) => operationId)
      .sort(),
  );
  for (const route of webhookRoutes) {
    const contract = getAdminOperationContract(route.operationId!);
    assert.ok(contract);
    assert.equal(route.query, contract.query);
    assert.equal(route.body, contract.body);
    assert.equal(route.success, contract.success.schema);
    assert.equal(route.errors, adminErrorEnvelopeSchema);
  }
});

test("Events runtime routes bind every static contract", () => {
  const routes = createEventsAdminRoutes({
    stores: {} as never,
    adminAccess: {} as never,
    discordBotToken: "token",
    services: { eventsService: {} as never },
  });
  assert.deepEqual(
    routes.map(({ operationId }) => operationId).sort(),
    Object.values(eventsContracts)
      .map(({ operationId }) => operationId)
      .sort(),
  );
  for (const route of routes) {
    const contract = getAdminOperationContract(route.operationId!);
    assert.ok(contract);
    assert.equal(route.query, contract.query);
    assert.equal(route.body, contract.body);
    assert.equal(route.success, contract.success.schema);
    assert.equal(route.errors, adminErrorEnvelopeSchema);
  }
});

test("Player Count and Player Link runtime routes bind every static contract", () => {
  const routes = createIntegrationsAdminRoutes({
    stores: {} as never,
    adminAccess: {} as never,
    discordBotToken: "token",
  }).filter(
    ({ path }) =>
      path.startsWith("/admin/api/player-count") || path.startsWith("/admin/api/player-link"),
  );
  const contracts = [...Object.values(playerCountContracts), ...Object.values(playerLinkContracts)];
  assert.deepEqual(
    routes.map(({ operationId }) => operationId).sort(),
    contracts.map(({ operationId }) => operationId).sort(),
  );
  for (const route of routes) {
    const contract = getAdminOperationContract(route.operationId!);
    assert.ok(contract);
    assert.equal(route.query, contract.query);
    assert.equal(route.body, contract.body);
    assert.equal(route.success, contract.success.schema);
    assert.equal(route.errors, adminErrorEnvelopeSchema);
  }
});

test("Cross-cutting runtime routes bind every shared contract", () => {
  const routes = [
    ...createUserProfileAdminRoutes({ store: {} as never, readCustomerSession: async () => null }),
    ...createGuildFeaturesAdminRoutes({
      stores: {} as never,
      adminAccess: {} as never,
      discordBotToken: "token",
    }),
    ...createGuildOverviewAdminRoutes({ stores: {} as never }),
    ...createPermissionsAdminRoutes({
      stores: {} as never,
      adminAccess: {} as never,
      discordBotToken: "token",
    }),
    ...createSocialAdminRoutes({
      stores: {} as never,
      adminAccess: {} as never,
      discordBotToken: "token",
    }),
    ...createSpaAdminRoutes({ adminRouteServices: {} as never } as never),
  ].filter((route) =>
    Object.values(crossCuttingContracts).some(
      ({ operationId }) => operationId === route.operationId,
    ),
  );
  const contracts = Object.values(crossCuttingContracts);
  assert.deepEqual(
    routes.map(({ operationId }) => operationId).sort(),
    contracts.map(({ operationId }) => operationId).sort(),
  );
  for (const route of routes) {
    const contract = getAdminOperationContract(route.operationId!);
    assert.ok(contract);
    assert.equal(route.query, contract.query);
    assert.equal(route.body, contract.body);
    assert.equal(route.success, contract.success.schema);
    assert.equal(route.errors, adminErrorEnvelopeSchema);
  }
});

test("Billing contracts cover the custom Billing API operation set", () => {
  const contracts = Object.values(billingContracts);
  assert.deepEqual(
    contracts.map(({ operationId }) => operationId).sort(),
    contracts.map(({ operationId }) => getAdminOperationContract(operationId)?.operationId).sort(),
  );
});
