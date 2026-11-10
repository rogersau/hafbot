import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BackgroundTaskTracker } from "../src/node/background-tasks";
import {
  createNodeHost,
  type ManagedNodeComponent,
  type NodeHost,
  type NodeRuntime,
} from "../src/node/host";
import { getRoleCapabilities, parseHafRole } from "../src/node/runtime-role";

test("HAF_ROLE is strict and maps to portable runtime capabilities", () => {
  assert.equal(parseHafRole(undefined), "all");
  assert.equal(parseHafRole(" API "), "api");
  assert.deepEqual(getRoleCapabilities("all"), {
    servesApi: true,
    components: ["gateway", "jobs", "scheduler"],
  });
  assert.deepEqual(getRoleCapabilities("jobs"), {
    servesApi: false,
    components: ["jobs", "scheduler"],
  });
  assert.throws(() => parseHafRole("worker"), /HAF_ROLE must be one of/);
  assert.throws(() => parseHafRole(""), /HAF_ROLE must be one of/);
});

test("production Node hosts require a strong status token", () => {
  const createRuntime = (): NodeRuntime => ({
    fetch: async () => new Response("ok"),
  });
  const options = { role: "api" as const, createRuntime, requireStatusToken: true };

  assert.throws(() => createNodeHost(options), /HAF_STATUS_TOKEN is required in production/);
  assert.throws(
    () => createNodeHost({ ...options, statusToken: "a".repeat(31) }),
    /between 32 and 512 characters/,
  );
  assert.throws(
    () => createNodeHost({ ...options, statusToken: `${"a".repeat(31)}!` }),
    /bearer-token characters/,
  );
  assert.doesNotThrow(() =>
    createNodeHost({ ...options, statusToken: "production-status-token-value-32" }),
  );
});

test("background tasks are capacity bounded, observed, and drained", async () => {
  const failures: unknown[] = [];
  const tracker = new BackgroundTaskTracker({
    maxPending: 1,
    onError: (error) => failures.push(error),
  });
  let finish: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  tracker.waitUntil(pending);
  assert.equal(tracker.pendingCount, 1);
  assert.throws(() => tracker.waitUntil(Promise.resolve()), /capacity of 1/);
  finish?.();
  assert.deepEqual(await tracker.drain(100), { completed: true, pending: 0 });
  assert.throws(() => tracker.waitUntil(Promise.resolve()), /draining/);
  assert.deepEqual(failures, []);
});

test("background tasks rejected by capacity or shutdown still have their failures observed", async () => {
  const failures: unknown[] = [];
  const tracker = new BackgroundTaskTracker({
    maxPending: 1,
    onError: (error) => failures.push(error),
  });
  let finish!: () => void;
  tracker.waitUntil(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const capacityFailure = new Error("capacity task failed");
  assert.throws(() => tracker.waitUntil(Promise.reject(capacityFailure)), /capacity of 1/);
  tracker.stopAccepting();
  const drainingFailure = new Error("draining task failed");
  assert.throws(() => tracker.waitUntil(Promise.reject(drainingFailure)), /draining/);
  finish();
  assert.deepEqual(await tracker.drain(100), { completed: true, pending: 0 });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(failures, [capacityFailure, drainingFailure]);
});

test("shutdown observes cleanup failures after an earlier component exhausts the deadline", async (t) => {
  let now = 0;
  t.mock.method(Date, "now", () => now);
  const failures: unknown[] = [];
  const events: string[] = [];
  const host = createNodeHost({
    role: "all",
    hostname: "127.0.0.1",
    port: 0,
    shutdownTimeoutMs: 100,
    onError: (error) => failures.push(error),
    createRuntime: () => ({
      fetch: async () => new Response("ok"),
      components: {
        gateway: {
          start: async () => undefined,
          async stop() {
            events.push("gateway:stop");
            throw new Error("gateway cleanup failed");
          },
        },
        jobs: {
          start: async () => undefined,
          async stop() {
            events.push("jobs:stop");
            await Promise.resolve();
            now = 100;
          },
        },
      },
      async close() {
        events.push("runtime:close");
        throw new Error("runtime cleanup failed");
      },
    }),
  });
  await host.start();
  t.after(() => host.shutdown("test_cleanup"));
  await host.shutdown();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(host.state, "stopped");
  assert.deepEqual(events, ["jobs:stop", "gateway:stop", "runtime:close"]);
  assert.equal(failures.length, 2);
  for (const failure of failures) assert.match(String(failure), /exceeded its deadline/);
});

test("all role exposes health, protects status, and stops components in reverse order", async (t) => {
  const events: string[] = [];
  const component = (name: string): ManagedNodeComponent => ({
    async start() {
      events.push(`${name}:start`);
    },
    async stop() {
      events.push(`${name}:stop`);
    },
    isReady: () => true,
    status: () => ({ name }),
  });
  const host = await startTestHost(t, {
    role: "all",
    statusToken: "status-secret",
    createRuntime: () => ({
      fetch: async (request) =>
        new Response(new URL(request.url).pathname, {
          headers: { "set-cookie": "session=abc; Path=/; HttpOnly" },
        }),
      components: {
        gateway: component("gateway"),
        jobs: component("jobs"),
        scheduler: component("scheduler"),
      },
      isReady: () => true,
      status: () => ({ database: "connected" }),
      async close() {
        events.push("runtime:close");
      },
    }),
  });

  const live = await fetch(`${host.baseUrl}/health/live`);
  assert.equal(live.status, 200);
  assert.deepEqual(await live.json(), { status: "live" });
  const ready = await fetch(`${host.baseUrl}/health/ready`);
  assert.equal(ready.status, 200);
  assert.equal(((await ready.json()) as { status: string }).status, "ready");

  assert.equal((await fetch(`${host.baseUrl}/internal/status`)).status, 404);
  const status = await fetch(`${host.baseUrl}/internal/status`, {
    headers: { authorization: "Bearer status-secret" },
  });
  assert.equal(status.status, 200);
  assert.equal(((await status.json()) as { role: string }).role, "all");

  const dynamic = await fetch(`${host.baseUrl}/admin`);
  assert.equal(await dynamic.text(), "/admin");
  assert.match(dynamic.headers.get("set-cookie") ?? "", /session=abc/);

  await host.instance.shutdown("test");
  assert.deepEqual(events, [
    "gateway:start",
    "jobs:start",
    "scheduler:start",
    "scheduler:stop",
    "jobs:stop",
    "gateway:stop",
    "runtime:close",
  ]);
});

test("shutdown lets active HTTP requests finish before closing the runtime", async (t) => {
  const events: string[] = [];
  let requestStarted: (() => void) | undefined;
  let finishRequest: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    requestStarted = resolve;
  });
  const finish = new Promise<void>((resolve) => {
    finishRequest = resolve;
  });
  const host = await startTestHost(t, {
    role: "api",
    createRuntime: () => ({
      async fetch() {
        events.push("request:start");
        requestStarted?.();
        await finish;
        events.push("request:end");
        return new Response("finished");
      },
      async close() {
        events.push("runtime:close");
      },
    }),
  });

  const response = fetch(`${host.baseUrl}/active`);
  await started;
  const shutdown = host.instance.shutdown("test");
  await new Promise<void>((resolve) => setImmediate(resolve));
  finishRequest?.();

  assert.equal(await (await response).text(), "finished");
  await shutdown;
  assert.deepEqual(events, ["request:start", "request:end", "runtime:close"]);
});

test("jobs role starts only jobs and scheduler and never serves application routes", async (t) => {
  const events: string[] = [];
  const component = (name: string): ManagedNodeComponent => ({
    start: async () => {
      events.push(`${name}:start`);
    },
    stop: async () => undefined,
    isReady: () => true,
  });
  const host = await startTestHost(t, {
    role: "jobs",
    createRuntime: () => ({
      fetch: async () => new Response("application"),
      components: {
        gateway: component("gateway"),
        jobs: component("jobs"),
        scheduler: component("scheduler"),
      },
    }),
  });

  assert.deepEqual(events, ["jobs:start", "scheduler:start"]);
  assert.equal((await fetch(`${host.baseUrl}/health/ready`)).status, 200);
  assert.equal((await fetch(`${host.baseUrl}/admin`)).status, 404);
});

test("read-only maintenance keeps health and reads available while rejecting mutations", async (t) => {
  const host = await startTestHost(t, {
    role: "api",
    maintenanceMode: true,
    statusToken: "maintenance-status",
    createRuntime: () => ({
      fetch: async (request) => new Response(`${request.method}:application`),
    }),
  });

  assert.equal((await fetch(`${host.baseUrl}/health/ready`)).status, 200);
  assert.equal(await (await fetch(`${host.baseUrl}/admin`)).text(), "GET:application");
  assert.equal(
    await (await fetch(`${host.baseUrl}/api/auth/get-session`)).text(),
    "GET:application",
  );
  const oauthCallback = await fetch(`${host.baseUrl}/api/auth/callback/discord?code=example`);
  assert.equal(oauthCallback.status, 503);
  assert.equal(oauthCallback.headers.get("x-haf-maintenance"), "read-only");
  for (const path of [
    "/auth/steam",
    "/auth/steam/callback",
    "/auth/xbox/start",
    "/auth/xbox/callback",
    "/commerce/return",
    "/commerce/support/return",
  ]) {
    assert.equal((await fetch(`${host.baseUrl}${path}?state=example`)).status, 503, path);
  }
  const mutation = await fetch(`${host.baseUrl}/webhooks/provider`, {
    method: "POST",
    body: "payload",
  });
  assert.equal(mutation.status, 503);
  assert.equal(mutation.headers.get("x-haf-maintenance"), "read-only");
  assert.equal(await mutation.text(), "Service is in read-only maintenance");
  const status = await fetch(`${host.baseUrl}/internal/status`, {
    headers: { authorization: "Bearer maintenance-status" },
  });
  assert.equal(((await status.json()) as { maintenanceMode: boolean }).maintenanceMode, true);
});

test("readiness fails closed when a selected component or runtime is unavailable", async (t) => {
  const host = await startTestHost(t, {
    role: "all",
    createRuntime: () => ({
      fetch: async () => new Response("unavailable", { status: 503 }),
      isReady: () => false,
    }),
  });
  const response = await fetch(`${host.baseUrl}/health/ready`);
  assert.equal(response.status, 503);
  const body = (await response.json()) as { checks: Record<string, boolean> };
  assert.equal(body.checks.runtime, false);
  assert.equal(body.checks.gateway, false);
  assert.equal(body.checks.jobs, false);
  assert.equal(body.checks.scheduler, false);
  assert.equal((await fetch(`${host.baseUrl}/health/live`)).status, 200);
});

test("dynamic routes take precedence and missing dynamic routes fall back to safe static assets", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "haf-node-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "admin", "assets"), { recursive: true });
  await writeFile(join(directory, "admin", "assets", "admin.js"), "static-admin");
  await writeFile(join(directory, "_headers"), "must-not-be-public");

  const host = await startTestHost(t, {
    role: "api",
    staticRoot: directory,
    createRuntime: () => ({
      fetch: async (request) => {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/admin") return new Response("dynamic-admin");
        return new Response("Not found", { status: 404 });
      },
    }),
  });

  assert.equal(await (await fetch(`${host.baseUrl}/admin`)).text(), "dynamic-admin");
  const asset = await fetch(`${host.baseUrl}/admin/assets/admin.js`);
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), "static-admin");
  assert.match(asset.headers.get("content-type") ?? "", /javascript/);
  const head = await fetch(`${host.baseUrl}/admin/assets/admin.js`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal((await fetch(`${host.baseUrl}/_headers`)).status, 404);
  assert.equal((await fetch(`${host.baseUrl}/admin/assets/../secret`)).status, 404);
});

test("Node request adaptation streams bodies, enforces limits, and preserves response cookies", async (t) => {
  const host = await startTestHost(t, {
    role: "api",
    maxRequestBytes: 5,
    createRuntime: () => ({
      fetch: async (request) => {
        const body = await request.text();
        const headers = new Headers({ "content-type": "text/plain" });
        headers.append("set-cookie", "first=1; Path=/; HttpOnly");
        headers.append("set-cookie", "second=2; Path=/; Secure");
        return new Response(body, { status: 201, headers });
      },
    }),
  });

  const accepted = await rawRequest(host.port, {
    method: "POST",
    path: "/echo",
    headers: { "content-length": "5" },
    chunks: ["12", "345"],
  });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body, "12345");
  assert.deepEqual(accepted.cookies, ["first=1; Path=/; HttpOnly", "second=2; Path=/; Secure"]);

  const rejected = await rawRequest(host.port, {
    method: "POST",
    path: "/echo",
    headers: { "content-length": "6" },
    chunks: ["123456"],
  });
  assert.equal(rejected.status, 413);
  assert.equal(rejected.body, "Request body too large");

  const chunked = await rawRequest(host.port, {
    method: "POST",
    path: "/echo",
    chunks: ["123", "456"],
  });
  assert.equal(chunked.status, 413);
});

test("Node request adaptation fixes the public origin and rejects authority-form targets", async (t) => {
  const host = await startTestHost(t, {
    role: "api",
    publicOrigin: "https://hafbot.xyz",
    createRuntime: () => ({
      fetch: async (request) => new Response(request.url),
    }),
  });

  const forwarded = await rawRequest(host.port, {
    method: "GET",
    path: "/safe?value=1",
    headers: {
      "x-forwarded-host": "attacker.example",
      "x-forwarded-proto": "http",
    },
    chunks: [],
  });
  assert.equal(forwarded.status, 200);
  assert.equal(forwarded.body, "https://hafbot.xyz/safe?value=1");

  const absolute = await rawRequest(host.port, {
    method: "GET",
    path: "http://attacker.example/unsafe",
    chunks: [],
  });
  assert.equal(absolute.status, 400);
  assert.equal(absolute.body, "Invalid request");
});

test("container files pin Node, minimize runtime tooling, run non-root, and preserve the runtime dependency boundary", async () => {
  const [dockerfile, dockerignore, compose, runtimePackage, rootPackage] = await Promise.all([
    readFile("Dockerfile", "utf8"),
    readFile(".dockerignore", "utf8"),
    readFile("compose.yaml", "utf8"),
    readFile("packages/node-runtime/package.json", "utf8"),
    readFile("package.json", "utf8"),
  ]);
  assert.match(
    dockerfile,
    /node:22\.23\.4-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d/,
  );
  assert.match(dockerfile, /packages\/node-runtime\/pnpm-lock\.yaml/);
  assert.match(dockerfile, /pnpm install --prod --frozen-lockfile --ignore-scripts/);
  assert.match(dockerfile, /rm -rf .*\/usr\/local\/lib\/node_modules\/npm/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /\/health\/live/);
  assert.doesNotMatch(dockerfile, /ARG\s+.*(?:TOKEN|SECRET|PASSWORD|KEY)/i);
  const runtimeManifest = JSON.parse(runtimePackage);
  assert.deepEqual(Object.keys(runtimeManifest.dependencies).sort(), [
    "@aws-sdk/client-s3",
    "@azure/identity",
    "@azure/storage-blob",
    "@sentry/node",
    "better-auth",
    "drizzle-orm",
    "effect",
    "pg",
    "ws",
    "zod",
  ]);
  const rootManifest = JSON.parse(rootPackage);
  assert.equal(
    runtimeManifest.dependencies["@sentry/node"],
    rootManifest.dependencies["@sentry/node"].replace(/^[~^]/, ""),
    "Production must run the Sentry SDK version used by the build and tests.",
  );
  const zodMajor = (specifier: unknown): string => {
    const match = String(specifier).match(/(?:^|[^0-9])(\d+)/);
    assert.ok(match, `Zod dependency ${String(specifier)} must include a major version.`);
    return match[1];
  };
  assert.equal(zodMajor(runtimeManifest.dependencies.zod), zodMajor(rootManifest.dependencies.zod));
  assert.match(dockerignore, /^\.env\*/m);
  assert.match(dockerignore, /^\.dev\.vars\*/m);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
});

test("VPS fallback has a tracked production-safe database contract", async () => {
  const [compose, example, readme] = await Promise.all([
    readFile("infra/self-host/compose.yaml", "utf8"),
    readFile("infra/self-host/.env.example", "utf8"),
    readFile("infra/self-host/README.md", "utf8"),
  ]);
  assert.match(compose, /DATABASE_URL: \$\{DATABASE_URL:\?Set DATABASE_URL/);
  assert.match(compose, /PG_ALLOW_INSECURE_DOCKER_NETWORK/);
  assert.match(example, /@postgres:5432\/haf\?sslmode=disable/);
  assert.match(example, /^PG_ALLOW_INSECURE_DOCKER_NETWORK=true$/m);
  assert.match(readme, /Managed PostgreSQL must use `sslmode=verify-full`/);
});

test("public container and Compose retain runtime isolation and an explicit deployment mode", async () => {
  const [dockerfile, dockerignore, compose, example, workflow] = await Promise.all([
    readFile("Dockerfile", "utf8"),
    readFile(".dockerignore", "utf8"),
    readFile("infra/self-host/compose.yaml", "utf8"),
    readFile("infra/self-host/.env.example", "utf8"),
    readFile(".github/workflows/ci.yml", "utf8"),
  ]);
  assert.match(dockerfile, /node:[^\s]+@sha256:[a-f0-9]{64}/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /pnpm install --prod --frozen-lockfile --ignore-scripts/);
  assert.doesNotMatch(dockerfile, /ARG\s+.*(?:TOKEN|SECRET|PASSWORD|KEY)/i);
  assert.match(dockerignore, /^\.env\*/m);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(example, /^HAF_DEPLOYMENT_MODE=self-hosted$/m);
  assert.match(example, /@postgres:5432\/haf\?sslmode=disable/);
  assert.match(workflow, /runs-on: ubuntu-24.04/);
  assert.match(workflow, /contents: read/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|pull_request_target|workflow_run|packages: write|id-token: write/,
  );
});

interface StartedTestHost {
  instance: NodeHost;
  baseUrl: string;
  port: number;
}

async function startTestHost(
  t: test.TestContext,
  options: {
    role: "all" | "api" | "gateway" | "jobs";
    createRuntime(): NodeRuntime;
    staticRoot?: string;
    statusToken?: string;
    maxRequestBytes?: number;
    maintenanceMode?: boolean;
    publicOrigin?: string;
  },
): Promise<StartedTestHost> {
  const host = createNodeHost({
    ...options,
    hostname: "127.0.0.1",
    port: 0,
    shutdownTimeoutMs: 1_000,
  });
  const address = await host.start();
  t.after(async () => {
    if (host.state !== "stopped") await host.shutdown("test_cleanup");
  });
  return { instance: host, port: address.port, baseUrl: `http://127.0.0.1:${address.port}` };
}

function rawRequest(
  port: number,
  options: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    chunks: string[];
  },
): Promise<{ status: number; body: string; cookies: string[] }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            cookies: response.headers["set-cookie"] ?? [],
          });
        });
      },
    );
    request.once("error", reject);
    for (const chunk of options.chunks) request.write(chunk);
    request.end();
  });
}
