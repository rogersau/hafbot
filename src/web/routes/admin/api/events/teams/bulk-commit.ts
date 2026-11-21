import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/events/teams/bulk-commit")({
  server: {
    handlers: {
      POST: handleAdminOperation("eventsTeamBulkCommit.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
