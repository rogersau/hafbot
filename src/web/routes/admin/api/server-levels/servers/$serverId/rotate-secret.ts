import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../../admin-api";

export const Route = createFileRoute("/admin/api/server-levels/servers/$serverId/rotate-secret")({
  server: {
    handlers: {
      POST: handleAdminOperation("serverLevelsServersServerIdRotateSecret.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
