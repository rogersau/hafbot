import { timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { BackgroundTaskTracker } from "./background-tasks";
import { createFetchRequestListener } from "./http-adapter";
import { getRoleCapabilities, type HafRole, type NodeComponentName } from "./runtime-role";
import { createDynamicFirstHandler, type FetchHandler } from "./static-assets";

export interface ManagedNodeComponent {
  start(): Promise<void>;
  stop(): Promise<void>;
  isReady?(): Promise<boolean> | boolean;
  status?(): Promise<unknown> | unknown;
}

export interface NodeRuntime {
  fetch: FetchHandler;
  components?: Partial<Record<NodeComponentName, ManagedNodeComponent>>;
  isReady?(): Promise<boolean> | boolean;
  status?(): Promise<unknown> | unknown;
  close?(): Promise<void>;
}

export interface CreateNodeRuntimeContext {
  waitUntil(task: Promise<unknown>): void;
}

export interface NodeHostOptions {
  role: HafRole;
  createRuntime(context: CreateNodeRuntimeContext): Promise<NodeRuntime> | NodeRuntime;
  hostname?: string;
  port?: number;
  publicOrigin?: string;
  staticRoot?: string;
  statusToken?: string;
  requireStatusToken?: boolean;
  maintenanceMode?: boolean;
  maxRequestBytes?: number;
  maxBackgroundTasks?: number;
  shutdownTimeoutMs?: number;
  onError?: (error: unknown) => void;
}

export type NodeHostState = "created" | "starting" | "ready" | "draining" | "stopped";

export interface ShutdownResult {
  backgroundTasksDrained: boolean;
  pendingBackgroundTasks: number;
}

export interface NodeHost {
  readonly role: HafRole;
  readonly state: NodeHostState;
  readonly address: AddressInfo | null;
  start(): Promise<AddressInfo>;
  shutdown(reason?: string): Promise<ShutdownResult>;
}

export function createNodeHost(options: NodeHostOptions): NodeHost {
  const hostname = options.hostname ?? "0.0.0.0";
  const port = options.port ?? 8080;
  const shutdownTimeoutMs = options.shutdownTimeoutMs ?? 25_000;
  validatePort(port);
  validateTimeout(shutdownTimeoutMs);
  validateStatusToken(options.statusToken, options.requireStatusToken ?? false);

  const roleCapabilities = getRoleCapabilities(options.role);
  const tasks = new BackgroundTaskTracker({
    maxPending: options.maxBackgroundTasks,
    onError: options.onError,
  });
  let state: NodeHostState = "created";
  let runtime: NodeRuntime | undefined;
  let server: Server | undefined;
  let address: AddressInfo | null = null;
  let activeRequests = 0;
  let startedComponents: NodeComponentName[] = [];
  let shutdownPromise: Promise<ShutdownResult> | undefined;

  const host: NodeHost = {
    role: options.role,
    get state() {
      return state;
    },
    get address() {
      return address;
    },
    async start() {
      if (state !== "created") throw new Error(`Cannot start Node host from ${state} state.`);
      state = "starting";
      try {
        runtime = await options.createRuntime({ waitUntil: tasks.waitUntil });
        const applicationHandler = createDynamicFirstHandler({
          dynamic: runtime.fetch,
          staticRoot: options.staticRoot,
        });
        const handler: FetchHandler = async (request) => {
          activeRequests += 1;
          try {
            return await handleHostRequest(request, {
              applicationHandler,
              getReadiness: readReadiness,
              getStatus: readStatus,
              role: options.role,
              state: () => state,
              statusToken: options.statusToken,
              maintenanceMode: options.maintenanceMode ?? false,
            });
          } finally {
            activeRequests -= 1;
          }
        };
        server = createServer(
          { maxHeaderSize: 32 * 1024 },
          createFetchRequestListener({
            handler,
            maxRequestBytes: options.maxRequestBytes,
            publicOrigin: options.publicOrigin,
            onError: options.onError,
          }),
        );
        server.requestTimeout = 30_000;
        server.headersTimeout = 15_000;
        server.keepAliveTimeout = 5_000;
        server.maxHeadersCount = 100;
        address = await listen(server, port, hostname);

        for (const name of roleCapabilities.components) {
          const component = runtime.components?.[name];
          if (!component) continue;
          await component.start();
          startedComponents.push(name);
        }
        state = "ready";
        return address;
      } catch (error) {
        options.onError?.(error);
        await host.shutdown("startup_failure");
        throw error;
      }
    },
    shutdown(reason = "shutdown") {
      if (shutdownPromise) return shutdownPromise;
      shutdownPromise = performShutdown(reason);
      return shutdownPromise;
    },
  };

  return host;

  async function readReadiness(): Promise<Record<string, boolean>> {
    const checks: Record<string, boolean> = {
      process: state === "ready",
      api: !roleCapabilities.servesApi || Boolean(runtime),
      runtime:
        Boolean(runtime) &&
        (runtime?.isReady ? await safelyReadReady(() => runtime!.isReady!()) : true),
    };
    for (const name of roleCapabilities.components) {
      const component = runtime?.components?.[name];
      checks[name] =
        Boolean(component) &&
        (component?.isReady ? await safelyReadReady(() => component.isReady!()) : true);
    }
    return checks;
  }

  async function readStatus(): Promise<Record<string, unknown>> {
    const components: Record<string, unknown> = {};
    for (const name of roleCapabilities.components) {
      const component = runtime?.components?.[name];
      components[name] = component
        ? component.status
          ? await safelyReadStatus(() => component.status!())
          : { configured: true }
        : { configured: false };
    }
    return {
      role: options.role,
      state,
      activeRequests,
      pendingBackgroundTasks: tasks.pendingCount,
      maintenanceMode: options.maintenanceMode ?? false,
      components,
      runtime: runtime?.status ? await safelyReadStatus(() => runtime!.status!()) : undefined,
    };
  }

  async function performShutdown(_reason: string): Promise<ShutdownResult> {
    if (state === "stopped") {
      return { backgroundTasksDrained: true, pendingBackgroundTasks: tasks.pendingCount };
    }
    state = "draining";
    const deadline = Date.now() + shutdownTimeoutMs;
    const serverClosed = closeServer(server);

    for (const name of [...startedComponents].reverse()) {
      const component = runtime?.components?.[name];
      if (!component) continue;
      await runBounded(() => component.stop(), deadline, options.onError);
    }
    startedComponents = [];

    const closed = await waitBounded(serverClosed, remainingMs(deadline));
    if (!closed) server?.closeAllConnections();
    tasks.stopAccepting();
    const background = await tasks.drain(remainingMs(deadline));
    if (runtime?.close) await runBounded(() => runtime!.close!(), deadline, options.onError);
    address = null;
    state = "stopped";
    return {
      backgroundTasksDrained: background.completed,
      pendingBackgroundTasks: background.pending,
    };
  }
}

interface HostRequestContext {
  applicationHandler: FetchHandler;
  getReadiness(): Promise<Record<string, boolean>>;
  getStatus(): Promise<Record<string, unknown>>;
  role: HafRole;
  state(): NodeHostState;
  statusToken?: string;
  maintenanceMode: boolean;
}

async function handleHostRequest(request: Request, context: HostRequestContext): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health/live") {
    const live = context.state() !== "stopped";
    return jsonResponse({ status: live ? "live" : "stopped" }, live ? 200 : 503);
  }
  if (url.pathname === "/health/ready") {
    const checks = await context.getReadiness();
    const ready = Object.values(checks).every(Boolean);
    return jsonResponse(
      { status: ready ? "ready" : "not_ready", role: context.role, checks },
      ready ? 200 : 503,
    );
  }
  if (url.pathname === "/internal/status") {
    if (!context.statusToken || !hasValidBearerToken(request, context.statusToken)) {
      return new Response("Not found", { status: 404 });
    }
    return jsonResponse(await context.getStatus(), 200);
  }
  if (context.state() === "draining") {
    return new Response("Service is draining", {
      status: 503,
      headers: { "cache-control": "no-store", "retry-after": "5" },
    });
  }
  if (!getRoleCapabilities(context.role).servesApi) {
    return new Response("Not found", { status: 404 });
  }
  if (context.maintenanceMode && !isMaintenanceReadOnlyRequest(request, url)) {
    return new Response("Service is in read-only maintenance", {
      status: 503,
      headers: {
        "cache-control": "no-store",
        "retry-after": "60",
        "x-haf-maintenance": "read-only",
      },
    });
  }
  return context.applicationHandler(request);
}

function isMaintenanceReadOnlyRequest(request: Request, url: URL): boolean {
  if (request.method === "OPTIONS") return true;
  if (request.method !== "GET" && request.method !== "HEAD") return false;

  // Better Auth uses GET callbacks that create sessions and workspace records. During maintenance,
  // only the exact session lookup is read-only; all other auth handlers must remain fenced.
  if (url.pathname === "/api/auth" || url.pathname.startsWith("/api/auth/")) {
    return url.pathname === "/api/auth/get-session";
  }
  if (/^\/auth\/(?:steam|xbox)(?:\/|$)/.test(url.pathname)) return false;
  if (url.pathname === "/commerce/return" || url.pathname === "/commerce/support/return") {
    return false;
  }
  return true;
}

function jsonResponse(value: unknown, status: number): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

function hasValidBearerToken(request: Request, expected: string): boolean {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const actualBytes = Buffer.from(authorization.slice("Bearer ".length));
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

async function safelyReadReady(reader: () => Promise<boolean> | boolean): Promise<boolean> {
  try {
    return await reader();
  } catch {
    return false;
  }
}

async function safelyReadStatus(reader: () => Promise<unknown> | unknown): Promise<unknown> {
  try {
    return await reader();
  } catch {
    return { unavailable: true };
  }
}

function validatePort(port: number): void {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("Node host port must be an integer between 0 and 65535.");
  }
}

function validateTimeout(timeoutMs: number): void {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Shutdown timeout must be a positive integer.");
  }
}

function validateStatusToken(statusToken: string | undefined, required: boolean): void {
  if (!required) return;
  if (!statusToken) {
    throw new Error("HAF_STATUS_TOKEN is required in production.");
  }
  if (statusToken.length < 32 || statusToken.length > 512) {
    throw new Error("HAF_STATUS_TOKEN must contain between 32 and 512 characters.");
  }
  if (!/^[A-Za-z0-9._~+/-]+={0,2}$/.test(statusToken)) {
    throw new Error("HAF_STATUS_TOKEN must use HTTP bearer-token characters only.");
  }
}

function listen(server: Server, port: number, hostname: string): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      const value = server.address();
      if (!value || typeof value === "string") {
        reject(new Error("Node host did not receive a TCP address."));
        return;
      }
      resolve(value);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, hostname);
  });
}

function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve) => {
    const closeIdleConnections = () => server.closeIdleConnections();
    const interval = setInterval(closeIdleConnections, 50);
    interval.unref();
    server.close(() => {
      clearInterval(interval);
      resolve();
    });
    closeIdleConnections();
  });
}

async function runBounded(
  operation: () => Promise<void>,
  deadline: number,
  onError: ((error: unknown) => void) | undefined,
): Promise<void> {
  try {
    const completed = await waitBounded(operation(), remainingMs(deadline));
    if (!completed) onError?.(new Error("Shutdown operation exceeded its deadline."));
  } catch (error) {
    onError?.(error);
  }
}

async function waitBounded(task: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) {
    // The operation is already running; an expired deadline must not leave
    // a later rejection unhandled during shutdown.
    void task.catch(() => undefined);
    return false;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<false>((resolve) => {
    timeout = setTimeout(() => resolve(false), timeoutMs);
    timeout.unref?.();
  });
  const completed = Promise.resolve(task).then(() => true);
  try {
    return await Promise.race([completed, expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}
