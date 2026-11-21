import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/server-levels")({
  server: {
    handlers: {
      DELETE: handleAdminOperation("serverLevels.delete"),
      GET: handleAdminOperation("serverLevels.get"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
