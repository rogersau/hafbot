import {
  createAdminApiHandler as createRuntimeAdminApiHandler,
  type AdminApiHandlerOptions,
} from "../../src/runtime/admin-api";
import type { AdminAccess } from "../../src/runtime/admin-access";
import type { ServiceFactory } from "../../src/runtime/service-factory";
import { composeTestDependencies } from "../support/compose-services";

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
  return createRuntimeAdminApiHandler({
    ...options,
    stores: selected.stores,
    services: { ...selected.services, ...options.services },
    adminAccess: options.adminAccess ?? allowAllAdminAccess,
  });
}
