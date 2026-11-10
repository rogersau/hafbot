export type { RouteHandler } from "../runtime/admin-spa-routes";
import { createAdminSpaRoutes, type AdminSpaRouteOptions } from "../runtime/admin-spa-routes";
import { createAdminApiHandler } from "../runtime/admin-api";
import type { AdminAccess } from "../runtime/admin-access";
import type { FeatureFlags } from "../runtime/features";
import type { RuntimeStores } from "../runtime/app-types";
import type { AdminRouteServices, WorkspaceAdminApi } from "../runtime/admin-routes";
import type { CustomerSession } from "../runtime/auth/customer-session";
import type { GuildResourceValidator } from "../discord/guild-resource-validator";
import type { ComponentIdSigner } from "../security/component-id-signer";

export interface AdminRouteOptions extends AdminSpaRouteOptions {
  handleAdminApiRequest?: (request: Request, url: URL) => Promise<Response | null>;
  services?: AdminRouteServices;
  stores: RuntimeStores;
  discordBotToken: string;
  discordBotUserId?: string;
  adminAccess: AdminAccess;
  workspaceApi?: WorkspaceAdminApi;
  features?: FeatureFlags;
  readCustomerAdminSession?: (request: Request) => Promise<CustomerSession | null>;
  configurationRevisionSigningSecret?: string;
  guildResources?: GuildResourceValidator;
  componentIdSigner?: ComponentIdSigner;
  [key: string]: unknown;
}

export function createAdminRoutes(options: AdminRouteOptions) {
  if (!options.stores) throw new Error("Admin route stores are required.");
  if (!options.discordBotToken) throw new Error("Admin route Discord bot token is required.");
  if (!options.adminAccess) throw new Error("Admin route authorizer is required.");

  const spaRoutes = createAdminSpaRoutes(options);
  const registryApi = createAdminApiHandler({
    stores: options.stores,
    discordBotToken: options.discordBotToken,
    discordBotUserId: options.discordBotUserId,
    adminAccess: options.adminAccess,
    features: options.features,
    adminRouteServices: options.services,
    workspaceApi: options.workspaceApi,
    readCustomerAdminSession: options.readCustomerAdminSession,
    configurationRevisionSigningSecret: options.configurationRevisionSigningSecret,
    guildResources: options.guildResources,
    componentIdSigner: options.componentIdSigner,
  });
  return async (request: Request): Promise<Response | null> => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/admin/api/")) {
      const delegated = options.handleAdminApiRequest
        ? await options.handleAdminApiRequest(request, url)
        : null;
      return delegated ?? registryApi(request, url);
    }
    return spaRoutes(request);
  };
}
