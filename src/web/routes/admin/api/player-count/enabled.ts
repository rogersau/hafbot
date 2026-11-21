import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/player-count/enabled")({
  server: {
    handlers: {
      POST: handleAdminOperation("playerCountEnabled.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
