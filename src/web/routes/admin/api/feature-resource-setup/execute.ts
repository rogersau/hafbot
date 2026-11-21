import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/feature-resource-setup/execute")({
  server: {
    handlers: {
      POST: handleAdminOperation("featureResourceSetupExecute.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
