import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/timed-roles/new-member-config")({
  server: {
    handlers: {
      POST: handleAdminOperation("timedRolesNewMemberConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
