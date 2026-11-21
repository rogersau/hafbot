import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/clans/setup/execute")({
  server: {
    handlers: {
      POST: handleAdminOperation("clansSetupExecute.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
