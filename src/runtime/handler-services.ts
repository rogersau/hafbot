import type { ServiceFactory } from "./service-factory";

/**
 * Constructed services read by slash-command dispatch.
 *
 * Composition constructs and owns these instances. The command handler never
 * builds, defaults, or substitutes the service graph itself. Optional entries
 * stay optional because composition treats those capabilities as optional.
 */
export type ApplicationCommandServices = Pick<
  ServiceFactory,
  | "blocklistService"
  | "timedRoleService"
  | "playerCountService"
  | "platformLinkService"
  | "evidenceVaultService"
  | "eventsService"
  | "clanService"
  | "ticketLifecycle"
  | "memberVerificationService"
  | "gatewayService"
>;

/**
 * Constructed services read by Discord interaction dispatch.
 */
export type InteractionServices = ApplicationCommandServices &
  Pick<
    ServiceFactory,
    | "banCaseEnforcement"
    | "banCaseService"
    | "suggestionService"
    | "lfgService"
    | "marketplaceService"
  >;
