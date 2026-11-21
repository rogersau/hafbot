import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/server-levels/config")({
  server: {
    handlers: {
      POST: handleAdminOperation("serverLevelsConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
