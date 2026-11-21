import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/timed-roles/manual-assignment-config")({
  server: {
    handlers: {
      POST: handleAdminOperation("timedRolesManualAssignmentConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
