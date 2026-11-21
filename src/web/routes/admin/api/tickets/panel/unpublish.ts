import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/tickets/panel/unpublish")({
  server: {
    handlers: {
      POST: handleAdminOperation("ticketsPanelUnpublish.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
