import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/configuration-revisions/restore")({
  server: {
    handlers: {
      POST: handleAdminOperation("configurationRevisionsRestore.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
