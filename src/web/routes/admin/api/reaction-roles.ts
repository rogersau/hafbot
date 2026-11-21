import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../admin-api";

export const Route = createFileRoute("/admin/api/reaction-roles")({
  server: {
    handlers: {
      DELETE: handleAdminOperation("reactionRoles.delete"),
      GET: handleAdminOperation("reactionRoles.get"),
      POST: handleAdminOperation("reactionRoles.post"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
