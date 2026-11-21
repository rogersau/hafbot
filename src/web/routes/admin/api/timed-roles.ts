import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/timed-roles")({
  server: {
    handlers: {
      GET: handleAdminOperation("timedRoles.get"),
      POST: handleAdminOperation("timedRoles.post"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
