import { createRuntimeApp as createProductionRuntimeApp } from "../../src/runtime/app";
import { composeApplicationServices } from "../../src/runtime/service-composition";
import { ALL_FEATURES_ENABLED } from "../../src/runtime/features";
import type { RuntimeAppOptions } from "../../src/runtime/app-types";
import type { ServiceFactory } from "../../src/runtime/service-factory";

export type TestRuntimeAppOptions = Omit<RuntimeAppOptions, "services"> & {
  /** TEST-ONLY partial service overrides applied to the composed graph. */
  services?: Partial<ServiceFactory>;
};

/**
 * Test-only runtime composition root.
 *
 * Composition runs once before app creation over the caller's persistent
 * fixture stores, producing the complete required service graph. Partial
 * service overrides replace single composed services for the behavior under
 * test; the app always receives a complete graph, never a Partial spread.
 */
export function createTestRuntimeApp(options: TestRuntimeAppOptions) {
  const { services: overrides, ...appOptions } = options;
  const services = {
    ...composeApplicationServices({
      ...appOptions,
      features: appOptions.features ?? ALL_FEATURES_ENABLED,
    }),
    ...overrides,
  };
  return createProductionRuntimeApp({ ...appOptions, services });
}
