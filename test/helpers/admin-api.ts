import {
  createAdminApiHandler as createRuntimeAdminApiHandler,
  type AdminApiHandlerOptions,
} from "../../src/runtime/admin-api";
import type { AdminAccess } from "../../src/runtime/admin-access";
import { getAdminOperationId } from "../../src/runtime/admin-route-registry";
import { createAdminRoutes } from "../../src/runtime/admin-routes";
import { ALL_FEATURES_ENABLED } from "../../src/runtime/features";
import type { ServiceFactory } from "../../src/runtime/service-factory";
import { composeTestDependencies } from "../support/compose-services";
import { matchAdminTestRoute } from "./admin-route";

export const allowAllAdminAccess: AdminAccess = {
  authorize() {
    return Promise.resolve({ ok: true as const });
  },
};

type TestAdminApiHandlerOptions = Omit<AdminApiHandlerOptions, "adminAccess" | "services"> & {
  adminAccess?: AdminAccess;
  services?: Partial<ServiceFactory>;
};

export function createAdminApiHandler(options: TestAdminApiHandlerOptions) {
  const selected = composeTestDependencies(options.stores, options.discordBotToken, {
    ...options,
    publicUrl: options.publicBaseUrl,
  });
  const dependencies = {
    ...options,
    stores: selected.stores,
    services: { ...selected.services, ...options.services },
    adminAccess: options.adminAccess ?? allowAllAdminAccess,
    features: options.features ?? ALL_FEATURES_ENABLED,
  };
  const routes = createAdminRoutes(dependencies);
  const handleOperation = createRuntimeAdminApiHandler(dependencies);
  return async (request: Request, url: URL): Promise<Response> => {
    const match = matchAdminTestRoute(routes, request.method, url.pathname);
    return match
      ? handleOperation(getAdminOperationId(match.route), request, match.params)
      : Response.json({ error: "Not found" }, { status: 404 });
  };
}
