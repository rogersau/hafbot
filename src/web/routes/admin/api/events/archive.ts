import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/events/archive")({
  server: {
    handlers: {
      POST: handleAdminOperation("eventsArchive.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
