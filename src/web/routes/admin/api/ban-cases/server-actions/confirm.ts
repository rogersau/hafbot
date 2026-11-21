import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/ban-cases/server-actions/confirm")({
  server: {
    handlers: {
      POST: handleAdminOperation("banCasesServerActionsConfirm.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
