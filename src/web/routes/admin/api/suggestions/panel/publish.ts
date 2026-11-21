import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/suggestions/panel/publish")({
  server: {
    handlers: {
      POST: handleAdminOperation("suggestions.panel.publish"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
