import type { AdminApiHandler } from "../runtime/admin-api";
import type { RuntimeAppOptions } from "../runtime/app-types";
import type { CustomerSessionUser } from "../runtime/auth/customer-session";
import type { BillingApiHandler } from "../runtime/billing/billing-api";
import type { PublicRuntimeEndpoints } from "./public-runtime-endpoints";

export interface WebRequestContext extends Pick<
  RuntimeAppOptions,
  "landingPriceCatalog" | "productAnalytics" | "selfHostedSite" | "waitUntil"
> {
  nonce: string;
  admin: {
    enabled?: boolean;
    authenticated: boolean;
    userProfile: Pick<CustomerSessionUser, "name" | "email" | "image"> | null;
    playstationLinkEnabled: boolean;
    workerVersion: string;
  };
  haf: PublicRuntimeEndpoints & {
    adminApi?: AdminApiHandler;
    checkGuildAccess(request: Request): Promise<Response | null>;
    readAdminDocument?(request: Request): Promise<WebRequestContext["admin"]["userProfile"]>;
    billingApi?: BillingApiHandler;
    logout(request: Request): Promise<Response>;
  };
}
