import assert from "node:assert/strict";
import test from "node:test";
import {
  mapAdminFailure,
  normalizeAdminErrorResponse,
} from "../src/runtime/admin-errors/admin-error-mapper";
import { createAdminRequestContext } from "../src/runtime/admin-errors/admin-request-context";
import { adminErrorEnvelopeSchema } from "../src/contracts/admin/errors";
import { AdminRouteError } from "../src/runtime/admin-errors/admin-route-error";

function context() {
  return createAdminRequestContext(new Request("https://hafbot.test/admin/api/test"), {
    operationId: "test.read",
    path: "/admin/api/test",
  });
}

test("unexpected Admin failures do not expose their cause", async () => {
  const response = mapAdminFailure(new Error("SQL token=top-secret"), context());
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(response.status, 500);
  assert.equal(body.code, "internal_error");
  assert.equal(JSON.stringify(body).includes("top-secret"), false);
  assert.equal(response.headers.get("x-correlation-id"), body.correlationId);
});

test("legacy Admin errors are upgraded at the central boundary", async () => {
  const response = await normalizeAdminErrorResponse(
    Response.json({ error: "Forbidden" }, { status: 403 }),
    context(),
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.code, "permission_denied");
  assert.equal(body.retryable, false);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("Admin error contract bounds stale-preview reasons", () => {
  const envelope = {
    error: "Discord channel state changed after preview.",
    code: "stale_preview",
    correlationId: "corr-1",
    retryable: false,
  };
  assert.equal(
    adminErrorEnvelopeSchema.safeParse({ ...envelope, staleReason: "source_and_target" }).success,
    true,
  );
  assert.equal(
    adminErrorEnvelopeSchema.safeParse({ ...envelope, staleReason: "untrusted-detail" }).success,
    false,
  );
});

test("AdminRouteError preserves a bounded stale-preview reason", async () => {
  const response = mapAdminFailure(
    new AdminRouteError({
      code: "stale_preview",
      status: 409,
      safeMessage: "Discord channel state changed after preview.",
      retryable: false,
      staleReason: "target",
    }),
    context(),
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.code, "stale_preview");
  assert.equal(body.staleReason, "target");
});

test("legacy stale-preview details are normalized to bounded reasons", async () => {
  const response = await normalizeAdminErrorResponse(
    Response.json(
      {
        error: "Discord channel state changed after preview.",
        code: "stale_preview",
        stale: "stale_source_and_target",
      },
      { status: 409 },
    ),
    context(),
  );
  const body = (await response.json()) as Record<string, unknown>;
  assert.equal(body.code, "stale_preview");
  assert.equal(body.staleReason, "source_and_target");
  assert.equal(body.stale, undefined);

  const unsafeResponse = await normalizeAdminErrorResponse(
    Response.json(
      {
        error: "Discord channel state changed after preview.",
        code: "stale_preview",
        stale: "raw",
      },
      { status: 409 },
    ),
    context(),
  );
  const unsafeBody = (await unsafeResponse.json()) as Record<string, unknown>;
  assert.equal(unsafeBody.staleReason, undefined);
});
