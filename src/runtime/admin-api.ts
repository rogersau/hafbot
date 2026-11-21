import {
  checkRouteCollisions,
  getAdminOperationId,
  runAdminRoute,
  type RouteParams,
} from "./admin-route-registry";
import { createAdminRoutes, type AdminRoutesOptions } from "./admin-routes";
import { ALL_FEATURES_ENABLED } from "./features";

export type AdminApiHandlerOptions = AdminRoutesOptions;

export type AdminApiHandler = (
  operationId: string,
  request: Request,
  params: RouteParams,
) => Promise<Response>;

export function createAdminApiHandler(options: AdminApiHandlerOptions): AdminApiHandler {
  if (!options.stores) throw new Error("Admin API stores are required.");
  if (!options.discordBotToken) throw new Error("Admin API Discord bot token is required.");
  if (!options.adminAccess) throw new Error("Admin API authorizer is required.");

  const features = options.features ?? ALL_FEATURES_ENABLED;
  const routes = createAdminRoutes({ ...options, features });
  checkRouteCollisions(routes);
  const operations = new Map(routes.map((route) => [getAdminOperationId(route), route]));
  const dispatchOptions = {
    adminAccess: options.adminAccess,
    features,
    stores: options.stores,
    environment: options.environment,
    productAnalytics: options.productAnalytics,
    waitUntil: options.waitUntil,
  };

  return async (operationId, request, params) => {
    const route = operations.get(operationId);
    if (route?.method === request.method) {
      const url = new URL(request.url);
      if (matchesOperationPath(route.path, url.pathname)) {
        return runAdminRoute(route, request, params, dispatchOptions, url);
      }
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  };
}

function matchesOperationPath(pattern: string, pathname: string): boolean {
  if (!pattern.includes(":")) return pattern === pathname;
  const expected = pattern.split("/");
  const actual = pathname.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) =>
      segment.startsWith(":") ? actual[index] !== "" : segment === actual[index],
    )
  );
}
