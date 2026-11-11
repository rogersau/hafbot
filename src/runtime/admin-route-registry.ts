import type { z } from "zod";
import { parseAdminBody, parseAdminQuery, parseErrorResponse } from "./admin-route-parsers";
import { isRecord } from "../unknown-parse";
import type { AdminAccess, AdminAccessRequirement } from "./admin-access";
import { createAdminAccessDeniedResponse } from "./admin-access";
import { withPremiumTier } from "./admin-route-guards";
import type { RuntimeStores } from "./app-types";
import type { FeatureFlags } from "./features";
import {
  createAdminRequestContext,
  type AdminRequestContext,
} from "./admin-errors/admin-request-context";
import { mapAdminFailure, normalizeAdminErrorResponse } from "./admin-errors/admin-error-mapper";
import {
  browserPrivacySignalEnabled,
  createInsertionId,
  type ProductAnalyticsReporter,
  type ProductFeature,
} from "../product-analytics";

export type RouteMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type RouteParams = Record<string, string>;

export type RouteContext<Q, B> = {
  request: Request;
  url: URL;
  params: RouteParams;
  query: Q;
  body: B;
  adminRequest?: AdminRequestContext;
};

export type RouteHandler<Q, B, R> = (context: RouteContext<Q, B>) => R | Promise<R>;

export type QuerySchema<Q> = z.ZodType<Q>;
export type BodySchema<B> = z.ZodType<B>;

export type PremiumTier = "reaction-limits" | "premium-only-features" | "steam-link" | "tickets";

export type PublicRouteAccess = "public";

export const PUBLIC_ADMIN_ROUTE_ACCESS: PublicRouteAccess = "public";

type RouteAccessPolicy = AdminAccessRequirement | PublicRouteAccess;

export type RouteAccess =
  | RouteAccessPolicy
  | ((context: {
      request: Request;
      url: URL;
      params: RouteParams;
      body?: unknown;
      query?: unknown;
    }) => RouteAccessPolicy | Response | Promise<RouteAccessPolicy | Response>);

export interface Route<Q = unknown, B = unknown, R = Response> {
  operationId?: string;
  method: RouteMethod;
  path: string;
  query?: QuerySchema<Q>;
  body?: BodySchema<B>;
  maxBodyBytes?: number;
  success?: z.ZodTypeAny;
  errors?: z.ZodTypeAny;
  paidOnly?: PremiumTier;
  feature?: keyof FeatureFlags;
  access: RouteAccess;
  handler: RouteHandler<Q, B, R>;
}

export function defineRoute<Q, B, R>(entry: Route<Q, B, R>): Route<Q, B, R> {
  entry.operationId ??= operationIdFor(entry.method, entry.path);
  return entry;
}

type AnyRoute = Route<any, any, Response>;

export interface DispatchOptions {
  adminAccess: AdminAccess;
  features: FeatureFlags;
  stores: RuntimeStores;
  environment?: string;
  productAnalytics?: ProductAnalyticsReporter;
  waitUntil?: (promise: Promise<unknown>) => void;
}

type DashboardMutation = {
  feature: ProductFeature;
  action: "configuration_saved" | "onboarding_verification_completed" | "resource_setup_completed";
  useEnabledAction?: boolean;
};

const DASHBOARD_MUTATIONS: Readonly<Record<string, DashboardMutation>> = {
  "POST /admin/api/blocklist": { feature: "reaction_rules", action: "configuration_saved" },
  "POST /admin/api/blocklist-channel": {
    feature: "reaction_rules",
    action: "configuration_saved",
  },
  "POST /admin/api/blocklist-channel-filter": {
    feature: "reaction_rules",
    action: "configuration_saved",
  },
  "POST /admin/api/reaction-limits/config": {
    feature: "reaction_rules",
    action: "configuration_saved",
    useEnabledAction: true,
  },
  "POST /admin/api/tickets/panel": { feature: "tickets", action: "configuration_saved" },
  "POST /admin/api/tickets/panel/create": {
    feature: "tickets",
    action: "configuration_saved",
  },
  "POST /admin/api/lfg/config": {
    feature: "lfg",
    action: "configuration_saved",
    useEnabledAction: true,
  },
  "POST /admin/api/member-verification/config": {
    feature: "member_verification",
    action: "configuration_saved",
    useEnabledAction: true,
  },
  "POST /admin/api/player-link/config": {
    feature: "player_link",
    action: "configuration_saved",
  },
  "POST /admin/api/server-levels/config": {
    feature: "server_levels",
    action: "configuration_saved",
    useEnabledAction: true,
  },
  "POST /admin/api/server-levels/servers": {
    feature: "server_levels",
    action: "resource_setup_completed",
  },
  "POST /admin/api/tickets/test-action": {
    feature: "tickets",
    action: "onboarding_verification_completed",
  },
};

export async function dispatchAdminRoute(
  routes: ReadonlyArray<AnyRoute>,
  request: Request,
  options: DispatchOptions,
  url: URL = new URL(request.url),
): Promise<Response | null> {
  const method = request.method;
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, url.pathname);
    if (params === null) continue;
    const operationId = route.operationId ?? operationIdFor(route.method, route.path);
    const adminRequest = createAdminRequestContext(
      request,
      { operationId, path: route.path },
      options.environment,
    );
    let bodyValue: unknown = undefined;
    try {
      const queryResult = route.query ? parseAdminQuery(url, route.query) : null;
      if (queryResult && !queryResult.ok) {
        return normalizeAdminErrorResponse(parseErrorResponse(queryResult.error), adminRequest);
      }
      if (route.body) {
        const workspaceId =
          route.maxBodyBytes === undefined ? await readWorkspaceIdFromBodyClone(request) : null;
        const bodyResult = await parseAdminBody(request, route.body, {
          maxBytes: route.maxBodyBytes,
        });
        if (!bodyResult.ok) {
          return normalizeAdminErrorResponse(parseErrorResponse(bodyResult.error), adminRequest);
        }
        bodyValue = bodyResult.value;
        if (workspaceId && isRecord(bodyValue) && !("workspaceId" in bodyValue)) {
          bodyValue = { ...bodyValue, workspaceId };
        }
      }
      const accessResult = await runAccessGuard(route, request, url, params, options, {
        query: queryResult?.value,
        body: bodyValue,
      });
      setAuthorisedScope(adminRequest, params, queryResult?.value, bodyValue);
      if (accessResult.response)
        return normalizeAdminErrorResponse(accessResult.response, adminRequest);
      const guardResponse = await runRouteGuards(
        route,
        url,
        params,
        options,
        accessResult.requirement,
      );
      if (guardResponse) return normalizeAdminErrorResponse(guardResponse, adminRequest);
      reportDashboardSetupStarted(route, request, bodyValue, options);
      const response = await route.handler({
        request,
        url,
        params,
        query: queryResult ? queryResult.value : undefined,
        body: bodyValue,
        adminRequest,
      });
      const normalized = await normalizeAdminErrorResponse(response, adminRequest);
      reportDashboardMutation(route, request, bodyValue, normalized, options);
      const schema = normalized.ok ? route.success : route.errors;
      if (schema) {
        const body = await normalized.clone().json();
        const parsed = schema.safeParse(body);
        if (!parsed.success) {
          throw new Error(`Invalid response for ${operationId}: ${parsed.error.message}`);
        }
      }
      return normalized;
    } catch (error) {
      const failure = await mapAdminFailure(error, adminRequest);
      reportDashboardMutation(route, request, bodyValue, failure, options);
      return failure;
    }
  }
  return null;
}

function reportDashboardMutation(
  route: AnyRoute,
  request: Request,
  body: unknown,
  response: Response,
  options: DispatchOptions,
): void {
  if (
    route.method === "GET" ||
    route.path.startsWith("/admin/api/product-analytics/") ||
    !options.productAnalytics ||
    browserPrivacySignalEnabled(request) ||
    !isRecord(body)
  ) {
    return;
  }
  const guildId = typeof body.guildId === "string" ? body.guildId : undefined;
  const mutation = dashboardMutation(route, body);
  if (!guildId || !mutation) return;
  const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
  const action =
    mutation.action === "resource_setup_completed"
      ? "resource_setup_completed"
      : mutation.useEnabledAction && enabled === true
        ? "feature_enabled"
        : mutation.useEnabledAction && enabled === false
          ? "feature_disabled"
          : mutation.action;
  const status = response.ok ? "success" : "failure";
  const reasonCode = response.ok
    ? undefined
    : response.status >= 500
      ? "storage_unavailable"
      : "invalid_configuration";
  const delivery = options.productAnalytics
    .report({
      name: "dashboard_milestone",
      insertionId: createInsertionId(),
      guildId,
      action,
      feature: mutation.feature,
      status,
      reasonCode,
    })
    .catch(() => undefined);
  options.waitUntil?.(delivery);
}

function dashboardMutation(
  route: AnyRoute,
  body: Record<string, unknown>,
): DashboardMutation | undefined {
  if (route.method === "POST" && route.path === "/admin/api/feature-resource-setup/execute") {
    const feature = analyticsFeatureForPath(route.path, body);
    return feature ? { feature, action: "resource_setup_completed" } : undefined;
  }
  return DASHBOARD_MUTATIONS[`${route.method} ${route.path}`];
}

function analyticsFeatureForPath(
  path: string,
  body?: Record<string, unknown>,
): ProductFeature | undefined {
  const surfaceKey = typeof body?.surfaceKey === "string" ? body.surfaceKey : undefined;
  if (
    surfaceKey === "reaction_rules" ||
    surfaceKey === "tickets" ||
    surfaceKey === "lfg" ||
    surfaceKey === "member_verification" ||
    surfaceKey === "player_link" ||
    surfaceKey === "server_levels"
  ) {
    return surfaceKey;
  }
  if (path.includes("blocklist") || path.includes("reaction-limit")) return "reaction_rules";
  if (path.includes("ticket")) return "tickets";
  if (path.includes("/lfg")) return "lfg";
  if (path.includes("member-verification")) return "member_verification";
  if (path.includes("platform-link") || path.includes("steam-link")) return "player_link";
  if (path.includes("server-levels")) return "server_levels";
  return undefined;
}

function reportDashboardSetupStarted(
  route: AnyRoute,
  request: Request,
  body: unknown,
  options: DispatchOptions,
): void {
  if (
    route.path !== "/admin/api/feature-resource-setup/execute" ||
    !options.productAnalytics ||
    browserPrivacySignalEnabled(request) ||
    !isRecord(body) ||
    typeof body.guildId !== "string"
  ) {
    return;
  }
  const feature = analyticsFeatureForPath(route.path, body);
  if (!feature) return;
  const delivery = options.productAnalytics
    .report({
      name: "dashboard_milestone",
      insertionId: createInsertionId(),
      guildId: body.guildId,
      action: "resource_setup_started",
      feature,
    })
    .catch(() => undefined);
  options.waitUntil?.(delivery);
}

async function runAccessGuard(
  route: AnyRoute,
  request: Request,
  url: URL,
  params: RouteParams,
  options: DispatchOptions,
  parsed: { query?: unknown; body?: unknown } = {},
): Promise<{ response: Response | null; requirement: AdminAccessRequirement | null }> {
  if (!route.access) {
    throw new Error(`Admin route ${route.method} ${route.path} has no access policy.`);
  }
  const requirement =
    typeof route.access === "function"
      ? await route.access({ request, url, params, query: parsed.query, body: parsed.body })
      : route.access;
  if (requirement instanceof Response) {
    return { response: requirement, requirement: null };
  }
  if (requirement === PUBLIC_ADMIN_ROUTE_ACCESS) {
    return { response: null, requirement: null };
  }
  const auth = await options.adminAccess.authorize(request, requirement);
  if (!auth.ok) {
    return { response: createAdminAccessDeniedResponse(auth.error), requirement };
  }
  return { response: null, requirement };
}

async function runRouteGuards(
  route: AnyRoute,
  url: URL,
  params: RouteParams,
  options: DispatchOptions,
  requirement: AdminAccessRequirement | null,
): Promise<Response | null> {
  if (route.paidOnly) {
    const guildId = requirement?.guildId ?? resolveGuildIdForPremiumGuard(url, params);
    if (guildId) {
      const denied = await withPremiumTier(route.paidOnly)(
        options.stores.guildEntitlements,
        guildId,
      );
      if (denied) return denied;
    }
  }
  if (route.feature && !options.features[route.feature]) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  return null;
}

async function readWorkspaceIdFromBodyClone(request: Request): Promise<string | null> {
  try {
    const body = await request.clone().json();
    return isRecord(body) && typeof body.workspaceId === "string" && body.workspaceId.length > 0
      ? body.workspaceId
      : null;
  } catch {
    return null;
  }
}

function resolveGuildIdForPremiumGuard(url: URL, params: RouteParams): string | null {
  if (params.guildId) return params.guildId;
  const fromQuery = url.searchParams.get("guildId");
  if (fromQuery) return fromQuery;
  return null;
}

function setAuthorisedScope(
  context: AdminRequestContext,
  params: RouteParams,
  query: unknown,
  body: unknown,
): void {
  const candidates = [params, query, body];
  for (const value of candidates) {
    if (!isRecord(value)) continue;
    if (!context.guildId && typeof value.guildId === "string") context.guildId = value.guildId;
    if (!context.workspaceId && typeof value.workspaceId === "string")
      context.workspaceId = value.workspaceId;
  }
}

export function checkRouteCollisions(routes: ReadonlyArray<AnyRoute>): void {
  const seen = new Map<string, AnyRoute>();
  const operations = new Set<string>();
  for (const route of routes) {
    const key = `${route.method} ${route.path}`;
    if (route.path.startsWith("/admin/api/") && !route.access) {
      throw new Error(`Admin route ${key} has no access policy.`);
    }
    const existing = seen.get(key);
    if (existing) {
      throw new Error(
        `Duplicate admin route registration: ${key} (handler ${existing.handler.name ?? "(anonymous)"} collides with ${route.handler.name ?? "(anonymous)"})`,
      );
    }
    seen.set(key, route);
    const operationId = route.operationId ?? operationIdFor(route.method, route.path);
    if (!/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/.test(operationId)) {
      throw new Error(`Invalid admin operation ID: ${operationId}`);
    }
    if (operations.has(operationId))
      throw new Error(`Duplicate admin operation ID: ${operationId}`);
    operations.add(operationId);
  }
}

function operationIdFor(method: RouteMethod, path: string): string {
  const words = path
    .replace(/^\/admin\/api\/?/, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const resource = words.length
    ? words
        .map((word, index) =>
          index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1),
        )
        .join("")
    : "admin";
  return `${resource}.${method.toLowerCase()}`;
}

export function matchPath(pattern: string, pathname: string): RouteParams | null {
  if (!pattern.includes(":")) {
    return pattern === pathname ? {} : null;
  }
  const patternParts = pattern.split("/");
  const pathParts = pathname.split("/");
  if (patternParts.length !== pathParts.length) {
    return null;
  }
  const params: RouteParams = {};
  for (let index = 0; index < patternParts.length; index += 1) {
    const patternPart = patternParts[index] ?? "";
    const pathPart = pathParts[index] ?? "";
    if (patternPart.startsWith(":")) {
      const key = patternPart.slice(1);
      try {
        params[key] = decodeURIComponent(pathPart);
      } catch {
        params[key] = pathPart;
      }
    } else if (patternPart !== pathPart) {
      return null;
    }
  }
  return params;
}
