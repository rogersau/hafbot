import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/server-levels/servers")({
  server: {
    handlers: {
      POST: handleAdminOperation("serverLevelsServers.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
