import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/tickets/transcript/revoke")({
  server: {
    handlers: {
      POST: handleAdminOperation("ticketsTranscriptRevoke.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
