import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/reaction-roles/enabled")({
  server: {
    handlers: {
      POST: handleAdminOperation("reactionRolesEnabled.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
