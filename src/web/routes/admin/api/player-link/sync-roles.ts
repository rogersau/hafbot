import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/player-link/sync-roles")({
  server: {
    handlers: {
      POST: handleAdminOperation("playerLinkSyncRoles.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
