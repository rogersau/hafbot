import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/guild-rbac/admin-role")({
  server: {
    handlers: {
      GET: handleAdminOperation("guildRbacAdminRole.get"),
      POST: handleAdminOperation("guildRbacAdminRole.post"),
      HEAD: handleUnknownAdminApiRequest,
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
