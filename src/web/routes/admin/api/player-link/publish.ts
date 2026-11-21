import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/player-link/publish")({
  server: {
    handlers: {
      POST: handleAdminOperation("playerLinkPublish.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
