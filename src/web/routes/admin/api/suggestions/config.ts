import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/suggestions/config")({
  server: {
    handlers: {
      PUT: handleAdminOperation("suggestions.config.update"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
