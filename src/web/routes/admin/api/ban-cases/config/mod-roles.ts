import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../../admin-api";

export const Route = createFileRoute("/admin/api/ban-cases/config/mod-roles")({
  server: {
    handlers: {
      POST: handleAdminOperation("banCasesConfigModRoles.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
