/// <reference types="node/assert" />
/// <reference types="node/assert/strict" />

import assert from "node:assert/strict";
// @ts-ignore -- The worker typecheck config omits Node built-ins and full node:test types conflict with Workers globals; tsconfig.tests provides the runtime test types.
import test from "node:test";

import { createAuthRoutes } from "../src/routes/auth-routes";

test("auth routes return null for non auth paths", async () => {
  const route = createAuthRoutes({
    handle: async () => new Response("should not be called", { status: 500 }),
  });

  const response = await route(new Request("https://worker.example/admin"));

  assert.equal(response, null);
});

test("auth routes delegate /api/auth/* to Better Auth", async () => {
  const seen: string[] = [];
  const route = createAuthRoutes({
    handle: async (request) => {
      seen.push(new URL(request.url).pathname);
      return Response.json({ status: "ok" });
    },
  });

  const response = await route(new Request("https://worker.example/api/auth/ok"));

  assert.equal(response?.status, 200);
  assert.deepEqual(seen, ["/api/auth/ok"]);
  assert.deepEqual(await response?.json(), { status: "ok" });
});

test("auth routes delegate the exact /api/auth path to Better Auth", async () => {
  const seen: string[] = [];
  const route = createAuthRoutes({
    handle: async (request) => {
      seen.push(new URL(request.url).pathname);
      return Response.json({ status: "ok" });
    },
  });

  const response = await route(new Request("https://worker.example/api/auth"));

  assert.equal(response?.status, 200);
  assert.deepEqual(seen, ["/api/auth"]);
  assert.deepEqual(await response?.json(), { status: "ok" });
});

test("auth routes report only a successful Discord callback", async () => {
  const completed: string[] = [];
  const route = createAuthRoutes({
    handle: async () => Response.redirect("https://worker.example/admin", 302),
    onDiscordSignInCompleted: (request) => completed.push(new URL(request.url).pathname),
  });

  await route(new Request("https://worker.example/api/auth/callback/discord"));
  await route(new Request("https://worker.example/api/auth/callback/github"));

  assert.deepEqual(completed, ["/api/auth/callback/discord"]);
});
