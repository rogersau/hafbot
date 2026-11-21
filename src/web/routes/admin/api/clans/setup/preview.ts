import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/clans/setup/preview")({
  server: {
    handlers: {
      POST: handleAdminOperation("clansSetupPreview.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
