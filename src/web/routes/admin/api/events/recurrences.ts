import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/events/recurrences")({
  server: {
    handlers: {
      POST: handleAdminOperation("eventsRecurrences.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
