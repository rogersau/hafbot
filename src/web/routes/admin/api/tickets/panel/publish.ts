import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/tickets/panel/publish")({
  server: {
    handlers: {
      POST: handleAdminOperation("ticketsPanelPublish.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
