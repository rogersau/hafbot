import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/tickets/panel/create")({
  server: {
    handlers: {
      POST: handleAdminOperation("ticketsPanelCreate.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
