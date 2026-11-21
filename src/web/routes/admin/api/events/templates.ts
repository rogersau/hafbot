import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/events/templates")({
  server: {
    handlers: {
      POST: handleAdminOperation("eventsTemplates.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
