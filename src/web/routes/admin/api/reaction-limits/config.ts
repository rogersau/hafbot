import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/reaction-limits/config")({
  server: {
    handlers: {
      POST: handleAdminOperation("reactionLimitsConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
