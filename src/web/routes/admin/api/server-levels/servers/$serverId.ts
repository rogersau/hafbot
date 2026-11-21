import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/server-levels/servers/$serverId")({
  server: {
    handlers: {
      DELETE: handleAdminOperation("serverLevelsServersServerId.delete"),
      PATCH: handleAdminOperation("serverLevelsServersServerId.patch"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
