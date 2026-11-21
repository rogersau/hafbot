import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/ban-appeals/config")({
  server: {
    handlers: {
      POST: handleAdminOperation("banAppealsConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
