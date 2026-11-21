import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/tickets/test-action")({
  server: {
    handlers: {
      POST: handleAdminOperation("ticketsTestAction.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
