import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/player-link/enabled")({
  server: {
    handlers: {
      POST: handleAdminOperation("playerLinkEnabled.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
