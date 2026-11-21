import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/ban-cases/server-actions/prepare")({
  server: {
    handlers: {
      POST: handleAdminOperation("banCasesServerActionsPrepare.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
