import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/events/signup")({
  server: {
    handlers: {
      POST: handleAdminOperation("eventsSignup.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
