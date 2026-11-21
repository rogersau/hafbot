import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/events/publish")({
  server: {
    handlers: {
      POST: handleAdminOperation("eventsPublish.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
