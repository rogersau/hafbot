import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/suggestions/transition")({
  server: {
    handlers: {
      POST: handleAdminOperation("suggestions.transition"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
