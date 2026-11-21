import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/configuration-revisions/restore-preview")({
  server: {
    handlers: {
      POST: handleAdminOperation("configurationRevisionsRestorePreview.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
