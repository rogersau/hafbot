import type { RuntimeStores } from "../../src/runtime/app-types";
import {
  createTicketLifecycle,
  type TicketLifecycle,
} from "../../src/services/tickets/ticket-lifecycle";

/**
 * Focused Ticket interaction fixture.
 *
 * Composition owns the production service graph. Tests that dispatch through
 * the Ticket interaction handler compose the lifecycle they exercise and pass
 * it through the required dependency seam; the handler never builds one.
 */
export function createTicketHandlerLifecycle(stores: RuntimeStores): TicketLifecycle {
  return createTicketLifecycle({
    tickets: stores.tickets,
    blocklist: stores.blocklist,
    entitlements: stores.guildEntitlements,
    messageTemplates: stores.messageTemplates,
  });
}
