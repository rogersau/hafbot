import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/events/recurrences/stop")({
  server: {
    handlers: {
      POST: handleAdminOperation("eventsRecurrencesStop.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
