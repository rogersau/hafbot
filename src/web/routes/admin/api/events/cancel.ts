import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/events/cancel")({
  server: {
    handlers: {
      POST: handleAdminOperation("eventsCancel.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
