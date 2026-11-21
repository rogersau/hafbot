import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/events/remove-signup")({
  server: {
    handlers: {
      POST: handleAdminOperation("eventsRemoveSignup.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
