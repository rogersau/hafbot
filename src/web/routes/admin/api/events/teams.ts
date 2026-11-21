import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/events/teams")({
  server: {
    handlers: {
      POST: handleAdminOperation("eventsTeam.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
