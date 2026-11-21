import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/tickets/panel")({
  server: {
    handlers: {
      GET: handleAdminOperation("ticketsPanel.get"),
      POST: handleAdminOperation("ticketsPanel.post"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
