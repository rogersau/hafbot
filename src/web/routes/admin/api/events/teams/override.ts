import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/events/teams/override")({
  server: {
    handlers: {
      POST: handleAdminOperation("eventsTeamOverride.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
