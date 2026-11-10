import {
  createAdminApiHandler as createRuntimeAdminApiHandler,
  type AdminApiHandlerOptions,
} from "../../src/runtime/admin-api";
import type { AdminAccess } from "../../src/runtime/admin-access";

export const allowAllAdminAccess: AdminAccess = {
  authorize() {
    return Promise.resolve({ ok: true as const });
  },
};

type TestAdminApiHandlerOptions = Omit<AdminApiHandlerOptions, "adminAccess"> & {
  adminAccess?: AdminAccess;
};

export function createAdminApiHandler(options: TestAdminApiHandlerOptions) {
  return createRuntimeAdminApiHandler({
    ...options,
    adminAccess: options.adminAccess ?? allowAllAdminAccess,
  });
}
