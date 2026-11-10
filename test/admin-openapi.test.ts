import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { z } from "zod";
import {
  createAdminOpenApiDocument,
  projectZodSchema,
  serializeAdminOpenApiDocument,
} from "../src/contracts/admin/openapi";
import { getCustomerAuthCookieSettings } from "../src/contracts/auth-session-cookie";

test("Admin OpenAPI exposes the registered Managed Messages operation and access contract", () => {
  const document = createAdminOpenApiDocument() as any;

  assert.equal(document.openapi, "3.1.0");
  assert.equal(
    document.paths["/admin/api/managed-messages"].get.operationId,
    "managedMessages.get",
  );
  assert.equal(document.paths["/admin/api/managed-messages"].post.requestBody.required, true);
  assert.equal(
    document.paths["/admin/api/managed-messages"].post["x-haf-entitlement"],
    "managedMessagesMax",
  );
  assert.deepEqual(document.paths["/admin/api/managed-messages"].get["x-haf-access"], {
    scope: "guild",
    mode: "read",
  });
});

test("Admin OpenAPI exposes shared authentication, error and retry contracts", () => {
  const document = createAdminOpenApiDocument() as any;
  const managedMessages = document.paths["/admin/api/managed-messages"].get;

  assert.deepEqual(managedMessages.security, [{ AdminSessionCookie: [] }]);
  assert.equal(
    document.paths["/admin/api/managed-messages/resources"].get.responses[429].headers[
      "Retry-After"
    ].schema.minimum,
    0,
  );
  assert.equal(
    managedMessages.responses[401].content["application/json"].schema.$ref,
    "#/components/schemas/AdminErrorEnvelopeV1",
  );
  assert.ok(document.components.schemas.AdminErrorEnvelopeV1.required.includes("correlationId"));
});

test("Admin OpenAPI publishes the secure production customer-session cookie", () => {
  const document = createAdminOpenApiDocument() as any;
  const scheme = document.components.securitySchemes.AdminSessionCookie;

  assert.equal(scheme["x-cookie-security"].secure, true);
  assert.equal(scheme.name, getCustomerAuthCookieSettings("https://hafbot.xyz").sessionToken.name);
  assert.equal(scheme.name, "__Secure-better-auth.session_token");
});

test("Admin OpenAPI reflects Zod object unknown-key behavior", () => {
  const stripSchema = z.object({ known: z.string() });
  const strictSchema = stripSchema.strict();

  assert.equal(stripSchema.safeParse({ known: "yes", extra: true }).success, true);
  assert.equal(projectZodSchema(stripSchema).additionalProperties, undefined);
  assert.equal(projectZodSchema(strictSchema).additionalProperties, false);
});

test("Admin OpenAPI artifact is deterministic and current", () => {
  const artifact = readFileSync(resolve("docs/generated/admin-api.openapi.json"), "utf8");
  assert.equal(artifact, serializeAdminOpenApiDocument());
  assert.equal(artifact.includes('"timestamp":'), false);
});

test("Admin OpenAPI represents durable JSON snapshots as unconstrained JSON", () => {
  assert.deepEqual(projectZodSchema(z.unknown(), "example.snapshot"), {});
});

test("Admin OpenAPI projection rejects unsupported Zod nodes with their location", () => {
  assert.throws(
    () => projectZodSchema(z.record(z.string(), z.string()), "example.payload"),
    /Unsupported Zod node at example\.payload: ZodRecord/,
  );
  assert.throws(
    () => projectZodSchema(z.string().email(), "example.email"),
    /Unsupported Zod string check at example\.email: email/,
  );
});
