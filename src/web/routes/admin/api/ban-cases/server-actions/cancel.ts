import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/ban-cases/server-actions/cancel")({
  server: {
    handlers: {
      POST: handleAdminOperation("banCasesServerActionsCancel.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
