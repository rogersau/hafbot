import { createFileRoute } from "@tanstack/react-router";
import { handleAdminOperation, handleUnknownAdminApiRequest } from "../../../../admin-api";

export const Route = createFileRoute("/admin/api/ban-cases/config")({
  server: {
    handlers: {
      POST: handleAdminOperation("banCasesConfig.post"),
      ANY: handleUnknownAdminApiRequest,
    },
  },
});
