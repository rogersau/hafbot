import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/feature-resource-setup/preview")({
  server: {
    handlers: {
      POST: handleAdminOperation("featureResourceSetupPreview.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
