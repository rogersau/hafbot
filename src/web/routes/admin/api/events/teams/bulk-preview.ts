import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/events/teams/bulk-preview")({
  server: {
    handlers: {
      POST: handleAdminOperation("eventsTeamBulkPreview.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
