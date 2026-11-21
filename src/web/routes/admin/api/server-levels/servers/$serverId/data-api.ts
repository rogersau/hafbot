import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../../admin-api";

export const Route = createFileRoute("/admin/api/server-levels/servers/$serverId/data-api")({
  server: {
    handlers: {
      DELETE: handleAdminOperation("serverLevelsServersServerIdDataApi.delete"),
      POST: handleAdminOperation("serverLevelsServersServerIdDataApi.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
