import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/tickets/panel/revisions")({
  server: {
    handlers: {
      GET: handleAdminOperation("ticketsPanelRevisions.get"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
