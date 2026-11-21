import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/player-count/server")({
  server: {
    handlers: {
      POST: handleAdminOperation("playerCountServer.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
