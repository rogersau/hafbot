import { after } from "node:test";
import type { RuntimeStores } from "../../src/runtime/app-types";
import { ALL_FEATURES_ENABLED } from "../../src/runtime/features";
import {
  composeApplicationServices,
  type ApplicationServicesComposition,
} from "../../src/runtime/service-composition";
import { createProductionRuntimeStores } from "./production-runtime-stores";

/** Complete selected services for focused route tests, composed once before dispatch. */
export function composeTestDependencies(
  stores: Partial<RuntimeStores> = {},
  discordBotToken = "test-token",
  capabilities: Partial<ApplicationServicesComposition> = {},
) {
  const fixture = createProductionRuntimeStores({ overrides: stores });
  after(() => fixture.close());
  const services = composeApplicationServices({
    ...capabilities,
    stores: fixture.stores,
    discordBotToken,
    discordPublicKey: "a".repeat(64),
    gateway: {
      async start() {
        return { configured: true };
      },
      async status() {
        return { configured: true };
      },
    },
    features: capabilities.features ?? ALL_FEATURES_ENABLED,
  });
  return { stores: fixture.stores, services };
}

export function composeTestServices(
  stores: Partial<RuntimeStores> = {},
  discordBotToken = "test-token",
) {
  return composeTestDependencies(stores, discordBotToken).services;
}
