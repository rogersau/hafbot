import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/events/teams/members")({
  server: {
    handlers: {
      POST: handleAdminOperation("eventsTeamMember.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
