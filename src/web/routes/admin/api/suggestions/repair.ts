import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/suggestions/repair")({
  server: {
    handlers: {
      POST: handleAdminOperation("suggestions.projection.repair"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
