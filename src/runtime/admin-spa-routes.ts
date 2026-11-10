import { isAdminDashboardPath, normalizeAdminDashboardPath } from "../admin/dashboard-routes";
import type { FeatureFlags } from "./features";
import { ALL_FEATURES_ENABLED } from "./features";
import type { CustomerSession } from "./auth/customer-session";

export interface AdminSpaRouteOptions {
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
  signOutCustomerAdminRequest?: (request: Request) => Promise<Response | null>;
  redirect: (location: string, headers?: HeadersInit) => Response;
  getAdminLoginLocation: (pathnameAndSearch: string) => string;
  renderAdminShell: (
    withAuth?: boolean,
    pathname?: string,
    search?: string,
    pageTitle?: string,
    userProfile?: Pick<CustomerSession["user"], "name" | "email" | "image"> | null,
    features?: Pick<FeatureFlags, "playstationLink">,
    workerVersion?: string,
  ) => Response;
  isAdminUiAuthorized: (request: Request) => Promise<boolean>;
  features?: FeatureFlags;
  workerVersion?: string;
}

export interface RouteHandler {
  (request: Request): Promise<Response | null>;
}

export function createAdminSpaRoutes(options: AdminSpaRouteOptions): RouteHandler {
  const features = options.features ?? ALL_FEATURES_ENABLED;
  return async (request: Request): Promise<Response | null> => {
    if (!features.adminUi) return null;
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/admin/login") {
      if (await options.isAdminUiAuthorized(request)) {
        return options.redirect("/admin");
      }
      return options.renderAdminShell(false, "/admin/login", url.search, "Sign in with Discord");
    }

    if (request.method === "POST" && url.pathname === "/admin/logout") {
      const headers = new Headers();
      const customerSignOut = await options.signOutCustomerAdminRequest?.(request);
      if (customerSignOut) {
        if (!customerSignOut.ok) return customerSignOut;
        const getSetCookie = (
          customerSignOut.headers as Headers & { getSetCookie?: () => string[] }
        ).getSetCookie;
        const fallbackSetCookie = customerSignOut.headers.get("set-cookie");
        const customerSetCookies = getSetCookie
          ? getSetCookie.call(customerSignOut.headers)
          : fallbackSetCookie
            ? [fallbackSetCookie]
            : [];
        for (const customerSetCookie of customerSetCookies) {
          headers.append("set-cookie", customerSetCookie);
        }
      }
      return options.redirect("/admin/login", headers);
    }

    if (request.method === "GET" && isAdminDashboardPath(url.pathname)) {
      if (!(await options.isAdminUiAuthorized(request))) {
        return options.redirect(options.getAdminLoginLocation(`${url.pathname}${url.search}`));
      }
      const customerSession = await options.readCustomerAdminSession?.(request);
      const dashboardPath = normalizeAdminDashboardPath(url.pathname);
      return options.renderAdminShell(
        true,
        dashboardPath,
        url.search,
        undefined,
        customerSession?.user ?? null,
        features,
        options.workerVersion,
      );
    }

    return null;
  };
}
