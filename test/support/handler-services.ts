import type {
  ApplicationCommandServices,
  InteractionServices,
} from "../../src/runtime/handler-services";

/**
 * Declares a handler dependency that a focused test does not expect to use.
 * Accessing an undeclared dependency fails loudly instead of silently
 * resolving a production default or constructing a service graph.
 */
export function undeclaredService<T>(name: string): T {
  return new Proxy(
    {},
    {
      get(_target, property) {
        throw new Error(
          `Test did not declare dependency ${name}.${String(property)}; inject the service the handler actually uses.`,
        );
      },
    },
  ) as unknown as T;
}

export function applicationCommandServices(
  overrides: Partial<ApplicationCommandServices> = {},
): ApplicationCommandServices {
  return {
    blocklistService: undeclaredService("blocklistService"),
    timedRoleService: undeclaredService("timedRoleService"),
    playerCountService: undeclaredService("playerCountService"),
    platformLinkService: undeclaredService("platformLinkService"),
    evidenceVaultService: undeclaredService("evidenceVaultService"),
    eventsService: undeclaredService("eventsService"),
    ticketLifecycle: undeclaredService("ticketLifecycle"),
    memberVerificationService: undeclaredService("memberVerificationService"),
    ...overrides,
  };
}

export function interactionServices(
  overrides: Partial<InteractionServices> = {},
): InteractionServices {
  return {
    ...applicationCommandServices(),
    banCaseService: undeclaredService("banCaseService"),
    suggestionService: undeclaredService("suggestionService"),
    lfgService: undeclaredService("lfgService"),
    marketplaceService: undeclaredService("marketplaceService"),
    ...overrides,
  };
}
