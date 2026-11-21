import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/reaction-roles/publish")({
  server: {
    handlers: {
      POST: handleAdminOperation("reactionRolesPublish.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
