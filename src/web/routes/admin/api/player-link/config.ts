import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/player-link/config")({
  server: {
    handlers: {
      POST: handleAdminOperation("playerLinkConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
