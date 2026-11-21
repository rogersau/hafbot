import {
  runAdminRoute,
  type DispatchOptions,
  type Route,
  type RouteParams,
} from "../../src/runtime/admin-route-registry";

type TestRoute = Route<any, any, Response>;

export function matchAdminTestRoute(
  routes: readonly TestRoute[],
  method: string,
  pathname: string,
) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPath(route.path, pathname);
    if (params) return { route, params };
  }
  return null;
}

export async function dispatchAdminRoute(
  routes: readonly TestRoute[],
  request: Request,
  options: DispatchOptions,
  url = new URL(request.url),
): Promise<Response | null> {
  const match = matchAdminTestRoute(routes, request.method, url.pathname);
  return match ? runAdminRoute(match.route, request, match.params, options, url) : null;
}

function matchPath(pattern: string, pathname: string): RouteParams | null {
  const expected = pattern.split("/");
  const actual = pathname.split("/");
  if (expected.length !== actual.length) return null;

  const params: RouteParams = {};
  for (const [index, segment] of expected.entries()) {
    const value = actual[index]!;
    if (segment.startsWith(":")) {
      try {
        params[segment.slice(1)] = decodeURIComponent(value);
      } catch {
        params[segment.slice(1)] = value;
      }
    } else if (segment !== value) {
      return null;
    }
  }
  return params;
}
