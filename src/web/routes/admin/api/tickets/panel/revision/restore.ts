import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../../admin-api";

export const Route = createFileRoute("/admin/api/tickets/panel/revision/restore")({
  server: {
    handlers: {
      POST: handleAdminOperation("ticketsPanelRevisionRestore.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
