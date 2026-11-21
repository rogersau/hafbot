import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/reaction-limits/counter/clear")({
  server: {
    handlers: {
      POST: handleAdminOperation("reactionLimitsCounterClear.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
