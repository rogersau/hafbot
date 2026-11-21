import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/tickets/transcript/rotate")({
  server: {
    handlers: {
      POST: handleAdminOperation("ticketsTranscriptRotate.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
